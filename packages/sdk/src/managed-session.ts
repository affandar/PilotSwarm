import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnAction, TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingActions: TurnAction[];
    queuedActions: TurnAction[];
    session: CopilotSession | null;
    waitThreshold: number;
}

const DEFAULT_WAIT_TOOL_DESCRIPTION =
    "REQUIRED: The ONLY way to wait, pause, sleep, or delay inside a turn. " +
    "You MUST call this tool whenever you need to wait, pause, delay, " +
    "poll, check back later, or pause before retrying. " +
    "Do NOT keep burning tokens in an in-turn polling loop; after one brief immediate re-check at most, yield with a durable timer. " +
    "For recurring or periodic schedules, use the cron tool instead. " +
    "If it is genuinely ambiguous whether the task should become an ongoing monitor, clarify before choosing a recurring schedule. " +
    "NEVER use bash sleep, setTimeout, setInterval, or any other external timing mechanism. " +
    "This tool enables durable waiting that survives process restarts. " +
    "Long waits may resume on a different worker unless you set " +
    "`preserveWorkerAffinity: true` for node-local work.";

function normalizeAssistantToolCallMessageContent(messages: any): number {
    if (!Array.isArray(messages)) return 0;
    let normalized = 0;
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        if (message.role !== "assistant") continue;
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
        if (message.content != null) continue;

        // Azure OpenAI rejects assistant tool-call messages when content is
        // null. The Copilot runtime may persist tool-only assistant turns in
        // that shape, so coerce them to the semantically-equivalent empty
        // string before sending the next turn.
        message.content = "";
        normalized += 1;
    }
    return normalized;
}

function normalizeCopilotSessionMessageHistory(session: any): number {
    let normalized = 0;
    normalized += normalizeAssistantToolCallMessageContent(session?._chatMessages);
    normalized += normalizeAssistantToolCallMessageContent(session?._systemContextMessages);
    return normalized;
}

function acknowledgeTurnBoundary(action: string): string {
    return `[SYSTEM: ${action} acknowledged. The runtime will suspend at the end of this turn. ` +
        `Finish any remaining tool results for the current step, then stop.]`;
}

function failureToolResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? "Tool failed");
    return {
        textResultForLlm: `Tool failed: ${message}`,
        resultType: "failure",
        error: message,
        toolTelemetry: {},
    };
}

function isBenignPostCompletionQueryError(eventData: any): boolean {
    if (!eventData || typeof eventData !== "object") return false;
    return eventData.errorType === "query"
        && String(eventData.message || "").includes("Cannot read properties of null (reading 'length')");
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
            // Defensive override: the Copilot SDK ships built-in tools named
            // `wait` in some configurations (e.g. the desktop-automation MCP
            // server). PilotSwarm's `wait` is the durable-timer version and
            // must always win in our worker.
            overridesBuiltInTool: true,
            description: DEFAULT_WAIT_TOOL_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                    preserveWorkerAffinity: {
                        type: "boolean",
                        description:
                            "Set true when the work you are waiting on is tied to this worker's local state " +
                            "(for example a local process, file, or socket) and you want PilotSwarm to " +
                            "preserve the current worker affinity across a durable wait.",
                    },
                },
                required: ["seconds"],
            },
            handler: async () => "stub",
        });

        const waitOnWorkerTool = defineTool("wait_on_worker", {
            description:
                "Durably wait while preserving the current worker affinity when possible. " +
                "Use this when the thing you are waiting on is tied to worker-local state " +
                "(for example a local process, file, socket, or in-memory store on this worker). " +
                "This is equivalent to wait(..., preserveWorkerAffinity=true), but more reliable " +
                "because you do not need to set the flag yourself.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting on worker-local state" },
                },
                required: ["seconds"],
            },
            handler: async () => "stub",
        });

        const cronTool = defineTool("cron", {
            description:
                "Declare a recurring durable schedule owned by the orchestration. " +
                "Use this for periodic monitoring, polling loops, and scheduled digests so you do NOT need to call wait() at the end of every turn. " +
                "Use this when you should keep pursuing a goal autonomously until it is done. " +
                "If it is genuinely ambiguous whether the task should become an ongoing recurring workflow, clarify that intent before setting cron. " +
                "Set or update the schedule with seconds + reason. Cancel it with action='cancel'. " +
                "Minimum interval is 15 seconds.",
            parameters: {
                type: "object",
                properties: {
                    seconds: {
                        type: "number",
                        description: "Interval between recurring wake-ups in seconds (minimum 15).",
                    },
                    reason: {
                        type: "string",
                        description: "What to do on each wake-up. Required when setting a schedule.",
                    },
                    action: {
                        type: "string",
                        enum: ["cancel"],
                        description: "Use action='cancel' to clear the active recurring schedule.",
                    },
                },
            },
            handler: async () => "stub",
        });

        const askUserTool = defineTool("ask_user", {
            // Defensive override: the Copilot SDK exposes an `ask_user` MCP
            // prompt and may surface it as a built-in tool in some configs.
            // PilotSwarm's `ask_user` routes through the durable orchestration
            // (so the request survives worker restarts) and must always win.
            overridesBuiltInTool: true,
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
                "Returns each model's exact qualified name (provider:model), description, and cost tier. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        return [waitTool, waitOnWorkerTool, cronTool, askUserTool, listModelsTool];
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
                "If the user explicitly asks you to use sub-agents, delegation, fan-out, or parallel processing, you should comply within runtime limits instead of collapsing the work into a direct answer. " +
                "If the user did not explicitly ask for delegation, use your judgment about whether parallel work is actually helpful. " +
                "Each agent adds cost, so avoid unnecessary fan-out when delegation was not requested. " +
                "For KNOWN user-creatable agents, pass agent_name. The agent's prompt, tools, and task load automatically. " +
                "Worker-managed system agents are NOT valid spawn_agent targets; if one is missing, the workers likely need to be restarted. " +
                "For CUSTOM agents (ad-hoc tasks), pass task instead. " +
                "Call ps_list_agents to see all available named agents you CAN spawn. " +
                "By default, sub-agents inherit the parent's model. " +
                "If you want to override the model, call list_available_models first and use only an exact provider:model value returned there. " +
                "Never invent, guess, or shorten model names.",
            parameters: {
                type: "object",
                properties: {
                    agent_name: {
                        type: "string",
                        description: "Name of a known user-creatable agent to spawn (from ps_list_agents). The agent's system message, tools, and initial prompt are loaded automatically. Do NOT also pass task or system_message. Worker-managed system agents are not valid here.",
                    },
                    task: {
                        type: "string",
                        description: "For custom agents only: a clear description of what the sub-agent should do. This becomes the agent's first prompt. Do NOT use this for known agents — use agent_name instead.",
                    },
                    model: {
                        type: "string",
                        description: "Optional exact provider:model override from list_available_models (e.g. 'anthropic:claude-sonnet-4-6'). Do not invent or shorten model names. If omitted, inherits parent's model.",
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
                "Check the current status and latest output of your RUNNING sub-agents (spawned with spawn_agent). " +
                "Returns each sub-agent's ID, task, status (running/completed/failed), and result. " +
                "This is NOT the same as ps_list_agents — ps_list_agents shows available agent blueprints, check_agents shows your live sub-agent instances.",
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
                "Returns each session's ID, title, owner, status, parent, and iteration count. " +
                "Use this to discover other running sessions or find sibling agents. " +
                "Leave owner filters unset for normal discovery and system-session checks; only set them when the user explicitly asks to scope by owner, user, system, or unowned sessions.",
            parameters: {
                type: "object",
                properties: {
                    include_system: {
                        type: "boolean",
                        description: "Include system sessions. Default true.",
                    },
                    owner_query: {
                        type: "string",
                        description: "Optional substring match across owner display name, email, subject, or provider. Not for session titles or agent names.",
                    },
                    owner_kind: {
                        type: "string",
                        enum: ["user", "system", "unowned"],
                        description: "Optional owner bucket filter. Use only when explicitly requested.",
                    },
                },
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
                "Gracefully cancel a running sub-agent. " +
                "Sends a cancel signal to the sub-agent so it can cascade cancellation to its own descendants and stop cleanly. " +
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
                "Gracefully delete a sub-agent entirely. " +
                "The sub-agent first follows the cancellation route for any live descendants, then deletes itself when the subtree is terminal. " +
                "ONLY works for sub-agents spawned and tracked by THIS current session via spawn_agent. " +
                "Use this only to clean up your own spawned sub-agents you no longer need.",
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
            pendingActions: [],
            queuedActions: [],
            session: this.copilotSession,
            waitThreshold: this.config.waitThreshold ?? 30,
        };
        const controlBridge = opts?.controlToolBridge;

        // Build system tools (wait tool + ask_user tool)
        const waitTool = defineTool("wait", {
            // Keep in sync with systemToolDefs() — defensive override.
            overridesBuiltInTool: true,
            description: DEFAULT_WAIT_TOOL_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting" },
                    preserveWorkerAffinity: {
                        type: "boolean",
                        description:
                            "Set true when the work you are waiting on is tied to this worker's local state " +
                            "(for example a local process, file, or socket) and you want PilotSwarm to " +
                            "preserve the current worker affinity across a durable wait.",
                    },
                },
                required: ["seconds"],
            },
            handler: async (args: { seconds: number; reason?: string; preserveWorkerAffinity?: boolean }) => {
                const reason = args.reason ?? "unspecified";
                if (args.seconds <= turnState.waitThreshold) {
                    await new Promise(r => setTimeout(r, args.seconds * 1000));
                    return `Waited for ${args.seconds} seconds. The wait is complete, you may continue.`;
                }
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.wait_started",
                            data: {
                                seconds: args.seconds,
                                reason,
                                preserveWorkerAffinity: args.preserveWorkerAffinity ?? false,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "wait",
                    seconds: args.seconds,
                    reason,
                    preserveWorkerAffinity: args.preserveWorkerAffinity ?? false,
                });
                return acknowledgeTurnBoundary("wait");
            },
        });

        const waitOnWorkerTool = defineTool("wait_on_worker", {
            description:
                "Durably wait while preserving the current worker affinity when possible. " +
                "Use this when the thing you are waiting on is tied to worker-local state " +
                "(for example a local process, file, socket, or in-memory store on this worker). " +
                "This is equivalent to wait(..., preserveWorkerAffinity=true), but more reliable " +
                "because you do not need to set the flag yourself.",
            parameters: {
                type: "object",
                properties: {
                    seconds: { type: "number", description: "How long to wait in seconds" },
                    reason: { type: "string", description: "Why you're waiting on worker-local state" },
                },
                required: ["seconds"],
            },
            handler: async (args: { seconds: number; reason?: string }) => {
                const reason = args.reason ?? "unspecified";
                if (args.seconds <= turnState.waitThreshold) {
                    await new Promise(r => setTimeout(r, args.seconds * 1000));
                    return `Waited for ${args.seconds} seconds on the current worker. The wait is complete, you may continue.`;
                }
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.wait_started",
                            data: {
                                seconds: args.seconds,
                                reason,
                                preserveWorkerAffinity: true,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "wait",
                    seconds: args.seconds,
                    reason,
                    preserveWorkerAffinity: true,
                });
                return acknowledgeTurnBoundary("wait_on_worker");
            },
        });

        const cronTool = defineTool("cron", {
            description:
                "Declare a recurring durable schedule owned by the orchestration. " +
                "Use this for periodic monitoring, polling loops, and scheduled digests so you do NOT need to call wait() at the end of every turn. " +
                "Use this when you should keep pursuing a goal autonomously until it is done. " +
                "If it is genuinely ambiguous whether the task should become an ongoing recurring workflow, clarify that intent before setting cron. " +
                "Set or update the schedule with seconds + reason. Cancel it with action='cancel'. " +
                "Minimum interval is 15 seconds.",
            parameters: {
                type: "object",
                properties: {
                    seconds: {
                        type: "number",
                        description: "Interval between recurring wake-ups in seconds (minimum 15).",
                    },
                    reason: {
                        type: "string",
                        description: "What to do on each wake-up. Required when setting a schedule.",
                    },
                    action: {
                        type: "string",
                        enum: ["cancel"],
                        description: "Use action='cancel' to clear the active recurring schedule.",
                    },
                },
            },
            handler: async (args: { seconds?: number; reason?: string; action?: "cancel" }) => {
                if (args.action === "cancel") {
                    turnState.queuedActions.push({
                        type: "cron",
                        action: "cancel",
                    });
                    return JSON.stringify({ status: "cancelled" });
                }

                const intervalSeconds = Number(args.seconds);
                if (!Number.isFinite(intervalSeconds)) {
                    return "Error: cron requires seconds or action='cancel'.";
                }
                if (intervalSeconds < 15) {
                    return "Error: cron interval must be at least 15 seconds.";
                }

                const reason = typeof args.reason === "string" ? args.reason.trim() : "";
                if (!reason) {
                    return "Error: cron reason is required when setting a schedule.";
                }

                turnState.queuedActions.push({
                    type: "cron",
                    action: "set",
                    intervalSeconds,
                    reason,
                });
                return JSON.stringify({ status: "scheduled", interval: intervalSeconds, reason });
            },
        });

        const askUserTool = defineTool("ask_user", {
            // Keep in sync with systemToolDefs() — defensive override.
            overridesBuiltInTool: true,
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
                if (opts?.onEvent) {
                    try {
                        opts.onEvent({
                            eventType: "session.input_required_started",
                            data: {
                                question: args.question,
                                choices: args.choices,
                                allowFreeform: args.allowFreeform ?? true,
                            },
                        });
                    } catch {}
                }
                turnState.pendingActions.push({
                    type: "input_required",
                    question: args.question,
                    choices: args.choices,
                    allowFreeform: args.allowFreeform ?? true,
                });
                return acknowledgeTurnBoundary("ask_user");
            },
        });

        // list_available_models — returns data inline (no abort/continuation needed)
        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's exact qualified name (provider:model), description, and cost tier. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
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
                "Spawn a sub-agent. For KNOWN user-creatable agents, pass agent_name ONLY. " +
                "The agent's system message, tools, and initial prompt are loaded automatically from agent_name. " +
                "Do NOT pass task or system_message when using agent_name. " +
                "Calling spawn_agent does NOT finish your turn. After it succeeds, continue executing the rest of your workflow in the SAME turn unless you intentionally call wait, wait_for_agents, ask_user, or give your final answer. " +
                "Call ps_list_agents to see all available named agents you CAN spawn. " +
                "Worker-managed system agents are not valid spawn_agent targets; if one is missing, the workers likely need to be restarted. " +
                "For CUSTOM agents (ad-hoc tasks), pass task instead — no agent_name is needed. " +
                "Any task you can describe can be spawned as a custom agent; you do not need a skill or pre-configured definition. " +
                "If you want a different model, call list_available_models first and use only an exact provider:model value from that list. " +
                "Never invent, guess, or shorten model names.",
            parameters: {
                type: "object",
                properties: {
                    agent_name: {
                        type: "string",
                        description: "Name of a known user-creatable agent to spawn (from ps_list_agents). The agent's prompt, tools, and task load automatically. Do NOT also pass task or system_message. Worker-managed system agents are not valid here.",
                    },
                    task: {
                        type: "string",
                        description: "For custom agents only: a clear description of what the sub-agent should do. Any task can be spawned — no pre-configured agent or skill is required.",
                    },
                    model: {
                        type: "string",
                        description: "Optional exact provider:model override from list_available_models. Do not invent or shorten model names.",
                    },
                    system_message: {
                        type: "string",
                        description: "Optional custom system message. Only for custom agents.",
                    },
                    tool_names: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tool names list. Only for custom agents.",
                    },
                    title: {
                        type: "string",
                        description: "Optional session title for the spawned sub-agent. Omit it to let the agent definition or later title summarization decide the name.",
                    },
                },
            },
            handler: async (args: { agent_name?: string; task?: string; model?: string; system_message?: string; tool_names?: string[]; title?: string }) => {
                if (!args.agent_name && !args.task) {
                    return "Error: either agent_name or task is required.";
                }
                if (controlBridge) {
                    return await controlBridge.spawnAgent(args);
                }
                turnState.pendingActions.push({
                    type: "spawn_agent",
                    task: args.task || "",
                    model: args.model,
                    systemMessage: args.system_message,
                    toolNames: args.tool_names,
                    agentName: args.agent_name,
                    title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined,
                });
                return acknowledgeTurnBoundary("spawn_agent");
            },
        });

        const messageAgentTool = defineTool("message_agent", {
            description:
                "Send a message to a running sub-agent. " +
                "The message is enqueued as a prompt for the sub-agent's next turn. " +
                "Calling message_agent does NOT finish your turn. After it succeeds, continue with the remaining workflow in the SAME turn unless you intentionally call wait, wait_for_agents, ask_user, or give your final answer.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    message: { type: "string", description: "The message to send to the sub-agent" },
                },
                required: ["agent_id", "message"],
            },
            handler: async (args: { agent_id: string; message: string }) => {
                if (controlBridge) {
                    return await controlBridge.messageAgent(args);
                }
                turnState.pendingActions.push({
                    type: "message_agent",
                    agentId: args.agent_id,
                    message: args.message,
                });
                return acknowledgeTurnBoundary("message_agent");
            },
        });

        const checkAgentsTool = defineTool("check_agents", {
            description:
                "Check the current status and latest output of your RUNNING sub-agents (spawned with spawn_agent). " +
                "Returns each sub-agent's ID, task, status (running/completed/failed), and result. " +
                "This is NOT the same as ps_list_agents — ps_list_agents shows available agent blueprints, check_agents shows your live sub-agent instances.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                if (controlBridge) {
                    return await controlBridge.checkAgents();
                }
                turnState.pendingActions.push({ type: "check_agents" });
                return acknowledgeTurnBoundary("check_agents");
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
                if (controlBridge) {
                    const resolvedAgentIds = await controlBridge.resolveWaitForAgents(args.agent_ids);
                    const normalizedAgentIds = Array.isArray(resolvedAgentIds)
                        ? resolvedAgentIds
                        : (args.agent_ids ?? []);
                    turnState.pendingActions.push({
                        type: "wait_for_agents",
                        agentIds: normalizedAgentIds,
                    });
                    return `[SYSTEM: wait_for_agents acknowledged for ${normalizedAgentIds.length} agent(s). ` +
                        `Continue any remaining work in this SAME turn. Once your current turn naturally ends, ` +
                        `the runtime will suspend until those agents complete.]`;
                }
                turnState.pendingActions.push({
                    type: "wait_for_agents",
                    agentIds: args.agent_ids ?? [],
                });
                return acknowledgeTurnBoundary("wait_for_agents");
            },
        });

        const listSessionsTool = defineTool("list_sessions", {
            description:
                "List all active sessions in the system. " +
                "Returns each session's ID, title, owner, status, parent, and iteration count. " +
                "Use this to discover other running sessions or find sibling agents. " +
                "Leave owner filters unset for normal discovery and system-session checks; only set them when the user explicitly asks to scope by owner, user, system, or unowned sessions.",
            parameters: {
                type: "object",
                properties: {
                    include_system: {
                        type: "boolean",
                        description: "Include system sessions. Default true.",
                    },
                    owner_query: {
                        type: "string",
                        description: "Optional substring match across owner display name, email, subject, or provider. Not for session titles or agent names.",
                    },
                    owner_kind: {
                        type: "string",
                        enum: ["user", "system", "unowned"],
                        description: "Optional owner bucket filter. Use only when explicitly requested.",
                    },
                },
            },
            handler: async (args: {
                include_system?: boolean;
                owner_query?: string;
                owner_kind?: string;
            }) => {
                if (controlBridge) {
                    return await controlBridge.listSessions(args);
                }
                turnState.pendingActions.push({
                    type: "list_sessions",
                    includeSystem: args.include_system,
                    ownerQuery: args.owner_query,
                    ownerKind: args.owner_kind,
                });
                return acknowledgeTurnBoundary("list_sessions");
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
                if (controlBridge) {
                    return await controlBridge.completeAgent(args);
                }
                turnState.pendingActions.push({ type: "complete_agent", agentId: args.agent_id });
                return acknowledgeTurnBoundary("complete_agent");
            },
        });

        const cancelAgentTool = defineTool("cancel_agent", {
            description:
                "Gracefully cancel a running sub-agent. " +
                "Sends a cancel signal to the sub-agent so it can cascade cancellation to its own descendants and stop cleanly. " +
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
                if (controlBridge) {
                    return await controlBridge.cancelAgent(args);
                }
                turnState.pendingActions.push({ type: "cancel_agent", agentId: args.agent_id, reason: args.reason });
                return acknowledgeTurnBoundary("cancel_agent");
            },
        });

        const deleteAgentTool = defineTool("delete_agent", {
            description:
                "Gracefully delete a sub-agent entirely. " +
                "The sub-agent first follows the cancellation route for any live descendants, then deletes itself when the subtree is terminal. " +
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
                if (controlBridge) {
                    return await controlBridge.deleteAgent(args);
                }
                turnState.pendingActions.push({ type: "delete_agent", agentId: args.agent_id, reason: args.reason });
                return acknowledgeTurnBoundary("delete_agent");
            },
        });

        const SYSTEM_TOOL_NAMES = new Set(["wait", "wait_on_worker", "cron", "ask_user", "list_available_models", "spawn_agent", "message_agent", "check_agents", "wait_for_agents", "list_sessions", "complete_agent", "cancel_agent", "delete_agent"]);

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
                handler: async (args: any, invocation: any) => {
                    const augmented = { ...invocation, durableSessionId };
                    try {
                        return await (t as any).handler(args, augmented);
                    } catch (error) {
                        return failureToolResult(error);
                    }
                },
            }));

        const allTools: Tool<any>[] = [
            ...wrappedUserTools,
            waitTool,
            waitOnWorkerTool,
            cronTool,
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
        const toolEventMetadataByKey = new Map<string, { toolName?: string; arguments?: unknown }>();
        let currentReasoning = "";
        let lastPublishedReasoning = "";
        let lastReasoningPublishAt = 0;
        let deferredSessionError: CapturedEvent | null = null;

        function getToolEventKey(eventData: any): string | null {
            if (!eventData || typeof eventData !== "object") return null;
            if (typeof eventData.toolCallId === "string" && eventData.toolCallId.trim()) {
                return `tool:${eventData.toolCallId}`;
            }
            if (typeof eventData.requestId === "string" && eventData.requestId.trim()) {
                return `request:${eventData.requestId}`;
            }
            return null;
        }

        function extractReasoningText(payload: any): string {
            if (typeof payload === "string") return payload;
            if (!payload || typeof payload !== "object") return "";
            return String(
                payload.deltaContent
                ?? payload.content
                ?? payload.text
                ?? payload.message
                ?? payload.delta
                ?? payload.reasoning
                ?? "",
            );
        }

        function mergeReasoningText(existing: string, incoming: string): string {
            const next = String(incoming || "");
            if (!next) return existing;
            if (!existing) return next;
            if (next.startsWith(existing)) return next;
            if (existing.endsWith(next)) return existing;
            return `${existing}${next}`;
        }

        function publishReasoningSnapshot(eventType: string, force = false) {
            const content = currentReasoning.trim();
            if (!content || content === lastPublishedReasoning) return;

            const now = Date.now();
            const lengthDelta = Math.abs(content.length - lastPublishedReasoning.length);
            if (!force && lengthDelta < 24 && now - lastReasoningPublishAt < 250) return;

            const captured: CapturedEvent = {
                eventType: "assistant.reasoning",
                data: {
                    content,
                    synthetic: true,
                    sourceEventType: eventType,
                },
            };
            collectedEvents.push(captured);
            lastPublishedReasoning = content;
            lastReasoningPublishAt = now;
            if (opts?.onEvent) {
                try { opts.onEvent(captured); } catch {}
            }
        }

        const turnComplete = new Promise<void>((resolve, reject) => {
            // Catch-all event handler — captures every event and fires onEvent immediately.
            unsubscribers.push(
                this.copilotSession.on((event: any) => {
                    const eventType = event.type ?? event.eventType ?? "unknown";
                    const rawEventData = event.data ?? event;
                    let eventData = rawEventData;

                    if (typeof rawEventData === "object" && rawEventData !== null) {
                        eventData = { ...rawEventData };

                        const toolEventKey = getToolEventKey(eventData);
                        const toolName = typeof eventData.toolName === "string" && eventData.toolName.trim()
                            ? eventData.toolName
                            : typeof eventData.name === "string" && eventData.name.trim()
                                ? eventData.name
                                : undefined;
                        const toolArguments = eventData.arguments ?? eventData.args;

                        if (toolEventKey && (toolName || toolArguments !== undefined)) {
                            const previous = toolEventMetadataByKey.get(toolEventKey) || {};
                            toolEventMetadataByKey.set(toolEventKey, {
                                toolName: toolName ?? previous.toolName,
                                arguments: toolArguments !== undefined ? toolArguments : previous.arguments,
                            });
                        }

                        if (toolEventKey) {
                            const metadata = toolEventMetadataByKey.get(toolEventKey);
                            if (metadata?.toolName && !eventData.toolName && !eventData.name) {
                                eventData.toolName = metadata.toolName;
                            }
                            if (metadata?.arguments !== undefined && eventData.arguments == null && eventData.args == null) {
                                eventData.arguments = metadata.arguments;
                            }
                        }

                        if (
                            eventType === "tool.execution_start"
                            || eventType === "tool.execution_complete"
                            || eventType === "tool.execution_partial_result"
                            || eventType.startsWith("external_tool.")
                        ) {
                            eventData.durableSessionId = durableSessionId;
                        }
                    }

                    const captured: CapturedEvent = { eventType, data: eventData };
                    if (eventType === "session.error" && isBenignPostCompletionQueryError(eventData)) {
                        deferredSessionError = captured;
                        return;
                    }
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
                    publishReasoningSnapshot("assistant.message", true);
                }),
            );

            unsubscribers.push(
                this.copilotSession.on("assistant.reasoning", (event: any) => {
                    currentReasoning = String(extractReasoningText(event?.data ?? event) || "").trim();
                    if (currentReasoning) {
                        lastPublishedReasoning = currentReasoning;
                        lastReasoningPublishAt = Date.now();
                    }
                }),
            );

            for (const eventType of ["assistant.reasoning_delta", "reasoning_delta"] as const) {
                unsubscribers.push(
                    (this.copilotSession as any).on(eventType, (event: any) => {
                        currentReasoning = mergeReasoningText(
                            currentReasoning,
                            extractReasoningText(event?.data ?? event),
                        );
                        publishReasoningSnapshot(eventType);
                    }),
                );
            }

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
                    publishReasoningSnapshot("session.idle", true);
                    resolve();
                }),
            );
        });

        // Optional timeout race — disabled by default.
        // Uses turnTimeoutMs from session config if set.
        const TURN_TIMEOUT = this.config.turnTimeoutMs ?? 0;
        const timeoutPromise = TURN_TIMEOUT > 0
            ? new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error("Turn timed out")), TURN_TIMEOUT);
            })
            : null;

        const effectivePrompt = opts?.requiredTool
            ? [
                `[SYSTEM: For this request, you MUST invoke the tool "${opts.requiredTool}" before giving your answer.`,
                `Do not answer from memory, estimation, or mental math.`,
                `If the tool is available, calling it is mandatory for this turn.]`,
                "",
                prompt,
            ].join("\n")
            : prompt;

        try {
            normalizeCopilotSessionMessageHistory(this.copilotSession as any);

            // Fire the prompt — non-blocking
            await this.copilotSession.send({
                prompt: effectivePrompt,
                ...(effectivePrompt !== prompt ? { displayPrompt: prompt } : {}),
                ...(opts?.requiredTool ? { requiredTool: opts.requiredTool } : {}),
            });

            // Wait for session.idle, or timeout if explicitly enabled.
            if (timeoutPromise) {
                await Promise.race([turnComplete, timeoutPromise]);
            } else {
                await turnComplete;
            }
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
            if (turnState.pendingActions.length === 0) {
                return { type: "error", message: errMsg };
            }
        } finally {
            // Always clean up subscriptions
            for (const unsub of unsubscribers) unsub();
        }

        // Check what ended the turn
        if (turnState.pendingActions.length > 0) {
            const [firstAction, ...remainingActions] = turnState.pendingActions;
            const combinedQueuedActions = [...turnState.queuedActions, ...remainingActions];
            const queuedActions = combinedQueuedActions.length > 0 ? combinedQueuedActions : undefined;

            switch (firstAction.type) {
                case "input_required":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                case "wait":
                    return { ...firstAction, content: finalContent, events: collectedEvents, queuedActions };
                case "cron":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                case "spawn_agent":
                    return { ...firstAction, content: finalContent, events: collectedEvents, queuedActions };
                case "message_agent":
                case "check_agents":
                case "wait_for_agents":
                case "list_sessions":
                case "complete_agent":
                case "cancel_agent":
                case "delete_agent":
                    return { ...firstAction, events: collectedEvents, queuedActions };
                default:
                    break;
            }
        }

        const completedQueuedActions = turnState.queuedActions.length > 0 ? turnState.queuedActions : undefined;

        if (deferredSessionError && !finalContent) {
            collectedEvents.push(deferredSessionError);
            if (opts?.onEvent) {
                try { opts.onEvent(deferredSessionError); } catch {}
            }
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
            queuedActions: completedQueuedActions,
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
        await this.copilotSession.disconnect();
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
        if (config.turnSystemPrompt !== undefined) this.config.turnSystemPrompt = config.turnSystemPrompt;
        if (config.waitThreshold !== undefined) this.config.waitThreshold = config.waitThreshold;
    }

    /** Get the underlying CopilotSession (for direct access when needed). */
    getCopilotSession(): CopilotSession {
        return this.copilotSession;
    }
}
