import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { CycleReport, TurnAction, TurnResult, TurnOptions, ManagedSessionConfig, CapturedEvent } from "./types.js";
import type { ReasoningEffort } from "./model-providers.js";

/**
 * Mutable state shared between the wait tool handler and runTurn().
 * @internal
 */
interface TurnState {
    pendingActions: TurnAction[];
    queuedActions: TurnAction[];
    cycleReport?: CycleReport;
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

const SESSION_SUMMARY_STATE_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["schemaVersion", "updatedAt", "intent", "summary", "state", "openQuestions", "blockers", "nextActions", "links", "structureChangeLog"],
    properties: {
        schemaVersion: { type: "number", enum: [1], description: "Always 1." },
        updatedAt: { type: "string", description: "Current ISO timestamp for this summary update." },
        intent: { type: "string", description: "What this session is trying to accomplish." },
        summary: { type: "string", description: "Concise durable summary of meaningful progress, current state, blockers, and outcome." },
        state: { type: "object", description: "Compact machine-readable state for the session; use {} if there is no structured state yet." },
        openQuestions: { type: "array", items: { type: "string" }, description: "Open questions that affect future work; [] if none." },
        blockers: { type: "array", items: { type: "string" }, description: "Current blockers; [] if none." },
        nextActions: { type: "array", items: { type: "string" }, description: "Concrete next actions; [] if none." },
        links: { type: "array", items: { type: "string" }, description: "Important URLs, artifact links, fact keys, or session ids; [] if none." },
        structureChangeLog: { type: "array", items: { type: "string" }, description: "Notable changes to the work structure, schedule, delegates, or scope; [] if none." },
        domain: { type: "string", description: "Optional domain label such as finance, ops, research, or support." },
    },
} as const;

const SESSION_SUMMARY_STATE_TEMPLATE =
    "Use summary_state={schemaVersion:1,updatedAt:<ISO timestamp>,intent:<string>,summary:<string>,state:{},openQuestions:[],blockers:[],nextActions:[],links:[],structureChangeLog:[]}.";

function hasAssistantToolCalls(message: any): boolean {
    return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isBlankAssistantContent(content: unknown): boolean {
    if (content == null) return true;
    if (typeof content === "string") return content.trim().length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return false;
}

function sanitizeMessageContent(message: any): number {
    if (!message || typeof message !== "object") return 0;
    if (message.content == null) {
        message.content = "";
        return 1;
    }
    if (!Array.isArray(message.content)) return 0;

    let normalized = 0;
    const parts = message.content.filter((part: any) => part != null);
    if (parts.length !== message.content.length) normalized += 1;
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(part, "text") && part.text == null) {
            part.text = "";
            normalized += 1;
        }
    }
    if (normalized > 0) message.content = parts;
    return normalized;
}

function sanitizeCopilotMessagesForReplay(messages: any): number {
    if (!Array.isArray(messages)) return 0;
    let normalized = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== "object") continue;
        if (message.role === "assistant" && !hasAssistantToolCalls(message) && isBlankAssistantContent(message.content)) {
            messages.splice(index, 1);
            normalized += 1;
            continue;
        }

        // Azure OpenAI rejects assistant tool-call messages when content is
        // null. The Copilot runtime may persist tool-only assistant turns in
        // that shape, so coerce them to the semantically-equivalent empty
        // string before sending the next turn.
        normalized += sanitizeMessageContent(message);
    }
    return normalized;
}

function normalizeCopilotSessionMessageHistory(session: any): number {
    let normalized = 0;
    normalized += sanitizeCopilotMessagesForReplay(session?._chatMessages);
    normalized += sanitizeCopilotMessagesForReplay(session?._systemContextMessages);
    return normalized;
}

function isEmptyAssistantTranscriptEvent(eventType: string, eventData: unknown): boolean {
    if (eventType !== "assistant.message") return false;
    if (!eventData || typeof eventData !== "object") return true;
    const data = eventData as Record<string, unknown>;
    const content = data.content ?? data.text ?? data.message;
    if (!isBlankAssistantContent(content)) return false;
    return !hasAssistantToolCalls(data) && data.toolCalls == null && data.reasoning == null;
}

function extractAssistantMessageContent(event: any): string | undefined {
    const content = event?.data?.content ?? event?.data?.text ?? event?.data?.message;
    return typeof content === "string" && content.trim() ? content : undefined;
}

function acknowledgeTurnBoundary(action: string): string {
    return `[SYSTEM: ${action} acknowledged. The runtime will suspend at the end of this turn. ` +
        `Finish any remaining tool results for the current step, then stop.]`;
}

const TERMINAL_TURN_BOUNDARY_ACTIONS = new Set(["completed", "wait", "input_required", "wait_for_agents", "list_sessions", "check_agents"]);

function hasTerminalTurnBoundary(turnState: TurnState): boolean {
    return turnState.pendingActions.some((action) => TERMINAL_TURN_BOUNDARY_ACTIONS.has(action.type));
}

function blockedAfterTurnBoundary(toolName: string): string {
    return `[SYSTEM: ${toolName} was not executed because a previous control tool already scheduled this turn to suspend. ` +
        `Stop now; the runtime will resume with the control-tool result.]`;
}

function splitQualifiedModel(model: string | undefined): { provider: string; model: string } {
    const configured = String(model || "").trim();
    if (!configured) return { provider: "(default)", model: "(default)" };
    const separator = configured.indexOf(":");
    if (separator <= 0) return { provider: "(unqualified)", model: configured };
    return {
        provider: configured.slice(0, separator),
        model: configured.slice(separator + 1),
    };
}

function formatCurrentModelConfig(config: ManagedSessionConfig): string {
    const configured = String(config.model || "").trim() || "(default)";
    const { provider, model } = splitQualifiedModel(config.model);
    const reasoningEffort = config.reasoningEffort ?? "(default)";
    return [
        "Current session configured model (this turn):",
        `- provider: ${provider}`,
        `- model: ${model}`,
        `- qualified_model: ${configured}`,
        `- reasoning_effort: ${reasoningEffort}`,
    ].join("\n");
}

// ── Tool-call-as-text guard ──────────────────────────────────────
// Some models (observed on claude-opus-4.8, especially on repetitive keepalive
// cron cycles) intermittently emit a tool call as literal
// `<invoke name="...">`/`<parameter>` text inside the assistant message instead
// of a real tool_use block. That text is never executed, so a consequential
// call (store_fact, complete_agent, an ADO write, etc.) would be silently
// dropped while the transcript implies it happened. We detect the malformed
// text and re-prompt the model — bounded — to actually invoke the tool.
const MAX_TEXT_TOOL_CALL_CORRECTIONS = 2;
const TEXT_TOOL_CALL_INVOKE_RE = /<(?:antml:)?invoke\s+name\s*=\s*"([^"]+)"/i;
const TEXT_TOOL_CALL_STRUCTURE_RE = /<\/(?:antml:)?invoke\s*>|<(?:antml:)?parameter\b/i;
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

/**
 * Detect a tool call the model emitted as literal text instead of a real
 * tool_use block. Requires both the `<invoke name="...">` opener and a closing
 * `</invoke>` or a `<parameter>` tag so prose that merely mentions the word
 * "invoke" does not trip the guard. Returns the tool name, or null.
 */
function detectTextEmittedToolCall(content: unknown): { toolName: string; rawContent: string } | null {
    if (typeof content !== "string" || content.length === 0) return null;
    const withoutExamples = content.replace(FENCED_CODE_BLOCK_RE, "");
    const nameMatch = withoutExamples.match(TEXT_TOOL_CALL_INVOKE_RE);
    if (!nameMatch) return null;
    if (!TEXT_TOOL_CALL_STRUCTURE_RE.test(withoutExamples)) return null;

    const beforeInvoke = withoutExamples.slice(0, nameMatch.index ?? 0).trim();
    const afterClose = withoutExamples.replace(/[\s\S]*<\/(?:antml:)?invoke\s*>/i, "").trim();
    if (afterClose) return null;

    // Allow the common one-token junk prefix observed from claude-opus-4.8
    // (for example "court\n<invoke ...>") but do not flag explanatory prose,
    // markdown docs, or examples that happen to contain Anthropic XML syntax.
    if (beforeInvoke && beforeInvoke.split(/\s+/).length > 1) return null;

    return { toolName: (nameMatch[1] || "").trim() || "the requested tool", rawContent: content };
}

function buildTextEmittedToolCallCorrection(toolName: string): string {
    const named = toolName && toolName !== "the requested tool" ? `the "${toolName}" tool` : "the intended tool";
    return `[SYSTEM: Tool-call protocol error. Your previous message contained a tool call written as literal text ` +
        `(for example \`<invoke name="${toolName}">\` with <parameter> tags). Text formatted like that is NOT executed — ` +
        `the tool did not run and produced no result, so anything you implied there has NOT actually happened. ` +
        `Come to your senses and actually invoke ${named} now using the real tool-calling mechanism, not text. ` +
        `Do not write <invoke> or <parameter> tags as message content. ` +
        `If you did not actually need a tool this turn, reply with plain prose only and no tool-call markup.]`;
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

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
    const effort = String(value || "").trim().toLowerCase();
    return effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh"
        ? effort
        : undefined;
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
    /** Set for the duration of runTurn(); read by the lock-bypassing stop path. */
    private activeTurn: { turnIndex: number; startedAt: number } | null = null;
    /** Set only by requestStop(); classifies the turn unwind as "stopped". */
    private stopRequest: { reason: string; requestedAt: number } | null = null;
    /** Resolver for the current turn's completion promise — hang escalation hook. */
    private settleTurnResolver: (() => void) | null = null;

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

        const cronAtTool = defineTool("cron_at", {
            description:
                "Declare a recurring wall-clock schedule owned by the orchestration. " +
                "Use this for calendar-anchored work like 'run nightly at 02:00 UTC' or 'fire Mondays at 09:00 America/New_York'. " +
                "Do NOT implement wall-clock schedules by polling every N minutes with cron(seconds=...) and checking the clock - that wastes tokens and turns. " +
                "For fixed-interval work like 'every 60 seconds', keep using cron(seconds, reason). " +
                "Recurrence is inferred from the fields you provide: minute (hourly), minute+hour (daily), minute+hour+day_of_week (weekly), minute+hour+day_of_month (monthly). " +
                "Pass max_fires=1 for a single one-shot scheduled-at-time action. " +
                "Cancel with action='cancel'.",
            parameters: {
                type: "object",
                properties: {
                    minute: { type: "number", description: "Wall-clock minute 0-59. Required when setting a schedule." },
                    hour: { type: "number", description: "Wall-clock hour 0-23. Omit for hourly recurrence." },
                    day_of_week: { type: "number", description: "0-6 with Sunday=0. Weekly recurrence; requires hour. Cannot combine with day_of_month." },
                    day_of_month: { type: "number", description: "1-31. Monthly recurrence; requires hour. Months without that day are skipped (no 'last day' semantics in v1)." },
                    tz: { type: "string", description: "IANA timezone (required). Examples: 'UTC', 'America/Los_Angeles'." },
                    max_fires: { type: "number", description: "Optional positive integer cap on total fires. Use 1 for a one-shot scheduled action." },
                    reason: { type: "string", description: "What to do on each wake-up. Required when setting a schedule." },
                    action: { type: "string", enum: ["cancel"], description: "Use action='cancel' to clear the active recurring schedule (works for either cron or cron_at)." },
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

        const reportCycleTool = defineTool("report_cycle", {
            description:
                "Report the outcome of the current recurring cron/cron_at watcher cycle when something material happened. " +
                "Use status='material' when the parent should be notified, and status='blocked' when the cycle found a blocker or failure that needs parent attention. " +
                "On an uneventful cycle, prefer NOT calling this tool at all — just end the turn silently; status='quiet' is accepted but unnecessary. " +
                "This tool does not end the turn; after calling it, finish normally. It is ignored outside recurring watcher cycles.",
            parameters: {
                type: "object",
                properties: {
                    status: { type: "string", enum: ["quiet", "material", "blocked"], description: "Whether this recurring cycle was quiet or should wake the parent." },
                    summary: { type: "string", description: "Optional concise machine-readable summary of the cycle outcome." },
                    deltas: { type: "array", items: { type: "string" }, description: "Optional concrete changes found this cycle." },
                },
                required: ["status"],
            },
            handler: async () => "stub",
        });

        const listModelsTool = defineTool("list_available_models", {
            description:
                "List all available LLM models across all configured providers. " +
                "Returns each model's exact qualified name (provider:model), description, and cost tier. " +
                "Also returns this session's current configured provider, model, and reasoning effort for the current turn. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
                "Models may also list supported reasoning efforts; pass spawn_agent(reasoning_effort=...) only with one of those listed values. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => "stub",
        });

        const setSessionModelTool = defineTool("set_session_model", {
            description:
                "Switch this session's model for the next turn boundary. " +
                "Call list_available_models first and pass an exact provider:model value returned there. " +
                "This ends the current turn. After it succeeds, stop; the runtime will continue on the selected model.",
            parameters: {
                type: "object",
                properties: {
                    model: { type: "string", description: "Exact provider:model value from list_available_models." },
                    reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "Optional reasoning effort supported by the selected model." },
                },
                required: ["model"],
            },
            handler: async () => "stub",
        });

        const updateSessionSummaryTool = defineTool("update_session_summary", {
            description:
                "Update this session's short live summary and optionally set this session's sticky title for session lists, discovery, and the Summary tab. " +
                "Call it automatically after first meaningful work and after each notable update: changed intent, tangible progress toward the user's goal, received cross-session replies, delivered outputs, blockers, open questions, next actions, key links, schedule/delegate changes, or terminal state. " +
                "Pass title when the user asks you to rename this session or when a durable human-readable title should stick; title updates lock the title against future automatic title summarization. " +
                "Keep it concise and scannable; use compact bullets or short Markdown tables for structured progress, comparisons, rankings, decisions, or result sets instead of prose blobs. " +
                "Do not paste long transcripts, raw logs, or bulky JSON into summary fields. " +
                "Do not call it for no-op heartbeats, timer wakes, or unchanged cron cycles. " +
                "Do not pass a string for summary_state. summary_state is optional only when title is provided. " + SESSION_SUMMARY_STATE_TEMPLATE,
            parameters: {
                type: "object",
                properties: {
                    summary_state: {
                        ...SESSION_SUMMARY_STATE_SCHEMA,
                        description: "Structured live summary state. Must be an object, not a string. Missing arrays should be [].",
                    },
                    short_summary: { type: "string", description: "Optional concise summary for session lists. If omitted, summary_state.summary is used." },
                    title: { type: "string", description: "Optional sticky session title. When set, it behaves like a manual rename and prevents future automatic title changes." },
                },
            },
            handler: async () => "stub",
        });

        const sendSessionMessageTool = defineTool("send_session_message", {
            description:
                "Send an auditable asynchronous request to another PilotSwarm session. Use list_sessions first to find the target session id. " +
                "Set expects_response=true when you need an answer back. The target must answer with reply_session_message; its normal chat transcript is not the response channel.",
            parameters: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "Target session id." },
                    subject: { type: "string", description: "Short request subject." },
                    body: { type: "string", description: "Request body, concise and self-contained." },
                    reason: { type: "string", enum: ["help", "guidance", "fact-request", "status-request", "handoff"], description: "Optional request reason." },
                    expects_response: { type: "boolean", description: "Whether a response is expected." },
                    expires_at: { type: "string", description: "Optional ISO timestamp after which the request is stale." },
                },
                required: ["session_id", "subject", "body"],
            },
            handler: async () => "stub",
        });

        const replySessionMessageTool = defineTool("reply_session_message", {
            description:
                "Reply to a cross-session request previously received from another PilotSwarm session. " +
                "Use this whenever a [SESSION_MESSAGE ... expects_response=true] prompt asks you for an answer. " +
                "Do not only write the answer in your own chat; the sender receives it only if this tool is called.",
            parameters: {
                type: "object",
                properties: {
                    request_id: { type: "string", description: "Request id being answered." },
                    session_id: { type: "string", description: "Session id that should receive the reply." },
                    verdict: { type: "string", enum: ["answered", "declined", "blocked", "stale"], description: "Reply outcome." },
                    body: { type: "string", description: "Reply body." },
                },
                required: ["request_id", "session_id", "body"],
            },
            handler: async () => "stub",
        });

        return [waitTool, waitOnWorkerTool, cronTool, cronAtTool, askUserTool, reportCycleTool, listModelsTool, setSessionModelTool, updateSessionSummaryTool, sendSessionMessageTool, replySessionMessageTool];
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
                "You MAY spawn multiple concurrent instances of the same agent_name (e.g. one per bug or per shard); they each get their own conversation. The only caps are the global maximum concurrent sub-agents and the maximum nesting depth. " +
                "Sub-agents do NOT auto-terminate when they finish their task \u2014 they stay alive idle, ready for follow-up via message_agent. YOU are responsible for closing each child with complete_agent (graceful), cancel_agent (interrupt), or delete_agent (forceful) when you no longer need it. " +
                "Worker-managed system agents are NOT valid spawn_agent targets; if one is missing, the workers likely need to be restarted. " +
                "For CUSTOM agents (ad-hoc tasks), pass task instead. " +
                "Call ps_list_agents to see all available named agents you CAN spawn. " +
                "By default, sub-agents inherit the parent's model. " +
                "If you want to override the model, call list_available_models first and use only an exact provider:model value returned there. " +
                "If you want to override reasoning power, also use only a reasoning_effort value listed for that model. " +
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
                    reasoning_effort: {
                        type: "string",
                        enum: ["low", "medium", "high", "xhigh"],
                        description: "Optional reasoning effort override for the sub-agent. Call list_available_models first and use only a reasoning value listed for the selected model. If omitted, inherits the parent's reasoning effort.",
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
                    title: {
                        type: "string",
                        description: "Optional session title for the spawned sub-agent. Omit it to let the agent definition or later title summarization decide the name.",
                    },
                    contract: {
                        type: "object",
                        description: "Optional named argument on spawn_agent; no separate contract tool exists. Example: contract={purpose:'Market scan',successCriteria:['answer with source-backed summary'],expectedFacts:[{key:'result/market-scan',required:true}],expectedArtifacts:[],validationMode:'warn',wakeOn:'material_change'}. Set wakeOn to 'any' for every update, 'material_change' (default) to suppress no-op heartbeats, or 'completion' for terminal updates only.",
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
                    contract_patch: { type: "object", description: "Optional structured patch to the child contract for follow-up work. Use 'wakeOn' here to update the parent wake policy for this child mid-flight (e.g. quiet a chatty watcher with wakeOn='material_change' or wake it up with 'any')." },
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
                        description: "Include system sessions. Default false.",
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
                    query: { type: "string", description: "Optional text search over title, agent id, owner, and summary fields." },
                    session_id: { type: "string", description: "Optional exact session id lookup." },
                    agent_id: { type: "string", description: "Optional exact named-agent id filter." },
                    state: { type: "string", description: "Optional lifecycle state filter." },
                    parent_session_id: { type: "string", description: "Optional direct parent session id filter." },
                    group_id: { type: "string", description: "Optional group id filter. Use the literal string 'null' for ungrouped sessions." },
                    include_children: { type: "boolean", description: "Include child sessions. Default false." },
                    updated_since: { type: "string", description: "Optional ISO timestamp; include sessions updated since this time." },
                    summary_updated_since: { type: "string", description: "Optional ISO timestamp; include sessions whose summary changed since this time." },
                    limit: { type: "number", description: "Maximum rows to return. Default 50, max 100." },
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
                    result: {
                        type: "object",
                        description: "Optional structured completion result with verdict, summary, output references, blockers, and next actions.",
                    },
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
                    partial_result: {
                        type: "object",
                        description: "Optional structured partial result for cancelled, blocked, or timed-out work.",
                    },
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
     *
     * Stop classification: a user stop (requestStop → abort) reclassifies the
     * unwind as `{ type: "stopped" }` regardless of how the inner turn settled
     * — checked BEFORE pendingActions so a stop that races a wait()/ask_user
     * control-tool abort wins instead of being swallowed into a durable timer,
     * and applied to error unwinds so a forced settle/disconnect is not
     * misclassified as a retryable error.
     */
    async runTurn(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
        this.activeTurn = { turnIndex: opts?.turnIndex ?? -1, startedAt: Date.now() };
        try {
            const result = await this._runTurnInner(prompt, opts);
            if (this.stopRequest) {
                return {
                    type: "stopped",
                    reason: this.stopRequest.reason,
                    ...((result as any)?.events ? { events: (result as any).events } : {}),
                };
            }
            return result;
        } catch (err) {
            if (this.stopRequest) {
                return { type: "stopped", reason: this.stopRequest.reason };
            }
            throw err;
        } finally {
            this.activeTurn = null;
            this.stopRequest = null;
            this.settleTurnResolver = null;
        }
    }

    /** The in-flight turn, if any. Read by the lock-bypassing stop path. */
    getActiveTurn(): { turnIndex: number; startedAt: number } | null {
        return this.activeTurn;
    }

    /**
     * Mark the in-flight turn as user-stopped so its unwind classifies as
     * `stopped`. Returns the active turn info, or null when no turn is
     * running. Does NOT abort by itself — callers pair this with abort().
     */
    requestStop(reason: string): { turnIndex: number } | null {
        if (!this.activeTurn) return null;
        this.stopRequest = { reason, requestedAt: Date.now() };
        return { turnIndex: this.activeTurn.turnIndex };
    }

    /**
     * Hang escalation: resolve the current turn's completion promise directly.
     * runTurn() settles only on the SDK's `session.idle` event; if a wedged
     * stream never fires it, this forces the unwind without depending on any
     * further SDK behavior. Pair with requestStop() so the unwind classifies
     * as `stopped`. Returns false when no turn is in flight.
     */
    forceSettleTurn(reason: string): boolean {
        if (!this.activeTurn) return false;
        if (!this.stopRequest) this.stopRequest = { reason, requestedAt: Date.now() };
        try { this.settleTurnResolver?.(); } catch {}
        return true;
    }

    private async _runTurnInner(prompt: string, opts?: TurnOptions): Promise<TurnResult> {
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait");
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

        const reportCycleTool = defineTool("report_cycle", {
            description:
                "Report the outcome of the current recurring cron/cron_at watcher cycle when something material happened. " +
                "Use status='material' when the parent should be notified, and status='blocked' when the cycle found a blocker or failure that needs parent attention. " +
                "On an uneventful cycle, prefer NOT calling this tool at all — just end the turn silently; status='quiet' is accepted but unnecessary. " +
                "This tool does not end the turn; after calling it, finish normally. It is ignored outside recurring watcher cycles.",
            parameters: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["quiet", "material", "blocked"],
                        description: "Whether this recurring cycle was quiet or should wake the parent.",
                    },
                    summary: {
                        type: "string",
                        description: "Optional concise machine-readable summary of the cycle outcome.",
                    },
                    deltas: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional concrete changes found this cycle.",
                    },
                },
                required: ["status"],
            },
            handler: async (args: { status: "quiet" | "material" | "blocked"; summary?: string; deltas?: string[] }) => {
                if (!opts?.cycleOrigin) {
                    return JSON.stringify({ ok: true, ignored: true, reason: "not_a_recurring_cycle" });
                }
                const status = args.status;
                if (status !== "quiet" && status !== "material" && status !== "blocked") {
                    return "Error: report_cycle status must be one of quiet, material, or blocked.";
                }
                turnState.cycleReport = {
                    status,
                    ...(typeof args.summary === "string" && args.summary.trim() ? { summary: args.summary.trim() } : {}),
                    ...(Array.isArray(args.deltas) ? { deltas: args.deltas.filter((delta) => typeof delta === "string" && delta.trim()).map((delta) => delta.trim()) } : {}),
                };
                return JSON.stringify({ ok: true, status });
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait_on_worker");
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

        const cronAtTool = defineTool("cron_at", {
            description:
                "Declare a recurring wall-clock schedule owned by the orchestration. " +
                "Use this for calendar-anchored work like 'run nightly at 02:00 UTC' or 'fire Mondays at 09:00 America/New_York'. " +
                "Do NOT implement wall-clock schedules by polling every N minutes with cron(seconds=...) and checking the clock - that wastes tokens and turns. " +
                "For fixed-interval work like 'every 60 seconds', keep using cron(seconds, reason). " +
                "Pass max_fires=1 for a single one-shot scheduled-at-time action. " +
                "Cancel with action='cancel'.",
            parameters: {
                type: "object",
                properties: {
                    minute: { type: "number", description: "Wall-clock minute 0-59. Required when setting a schedule." },
                    hour: { type: "number", description: "Wall-clock hour 0-23. Omit for hourly recurrence." },
                    day_of_week: { type: "number", description: "0-6 with Sunday=0. Weekly recurrence; requires hour. Cannot combine with day_of_month." },
                    day_of_month: { type: "number", description: "1-31. Monthly recurrence; requires hour. Months without that day are skipped (no 'last day' semantics in v1)." },
                    tz: { type: "string", description: "IANA timezone (required). Examples: 'UTC', 'America/Los_Angeles'." },
                    max_fires: { type: "number", description: "Optional positive integer cap on total fires. Use 1 for a one-shot scheduled action." },
                    reason: { type: "string", description: "What to do on each wake-up. Required when setting a schedule." },
                    action: { type: "string", enum: ["cancel"], description: "Use action='cancel' to clear the active recurring schedule (works for either cron or cron_at)." },
                },
            },
            handler: async (args: {
                minute?: number;
                hour?: number;
                day_of_week?: number;
                day_of_month?: number;
                tz?: string;
                max_fires?: number;
                reason?: string;
                action?: "cancel";
            }) => {
                if (args.action === "cancel") {
                    turnState.queuedActions.push({ type: "cron_at", action: "cancel" });
                    // Also surface cron cancellation so a single 'cancel' call clears whichever
                    // schedule kind is active. The orchestration treats this as idempotent.
                    turnState.queuedActions.push({ type: "cron", action: "cancel" });
                    return JSON.stringify({ status: "cancelled" });
                }
                const { normalizeCronAtInput, computeCronAtNextFire } = await import("./cron-at.js");
                const normalized = normalizeCronAtInput({
                    minute: args.minute,
                    hour: args.hour,
                    day_of_week: args.day_of_week,
                    day_of_month: args.day_of_month,
                    tz: args.tz,
                    max_fires: args.max_fires,
                    reason: args.reason,
                });
                if (!normalized.ok) {
                    return `Error: ${normalized.error}`;
                }
                const schedule = normalized.schedule;
                // Precompute the nextFireAt as a best-effort answer for the LLM. The orchestration
                // will recompute (and record) the authoritative next-fire via a durable activity.
                let preview: { nextFireAtMs?: number; localTime?: string } = {};
                try {
                    const r = computeCronAtNextFire(schedule, Date.now());
                    preview = { nextFireAtMs: r.nextFireAtMs, localTime: r.localTime };
                } catch {
                    // ignore; orchestration will compute the authoritative result
                }
                turnState.queuedActions.push({
                    type: "cron_at",
                    action: "set",
                    schedule,
                });
                return JSON.stringify({
                    status: "scheduled",
                    kind: "wall-clock",
                    nextFireAt: preview.nextFireAtMs ? new Date(preview.nextFireAtMs).toISOString() : undefined,
                    localTime: preview.localTime,
                    tz: schedule.tz,
                    reason: schedule.reason,
                    ...(schedule.maxFires !== undefined ? { maxFires: schedule.maxFires } : {}),
                });
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("ask_user");
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
                "Also returns this session's current configured provider, model, and reasoning effort for the current turn. " +
                "This output is the authoritative source for model selection. " +
                "Use this when choosing the best model for a sub-agent task, or when the user asks about available models. " +
                "If you plan to pass spawn_agent(model=...), you must choose an exact provider:model value from this list and must not invent or shorten names. " +
                "Models may also list supported reasoning efforts; pass spawn_agent(reasoning_effort=...) only with one of those listed values. " +
                "When choosing a model for a sub-agent, prefer lower-cost models for simple tasks " +
                "and higher-cost models for complex reasoning tasks.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                return [
                    formatCurrentModelConfig(this.config),
                    opts?.modelSummary || "No model providers configured.",
                ].join("\n\n");
            },
        });

        const setSessionModelTool = defineTool("set_session_model", {
            description:
                "Switch this session's model for the next turn boundary. " +
                "Call list_available_models first and pass an exact provider:model value returned there. " +
                "This ends the current turn. After it succeeds, stop; the runtime will continue on the selected model.",
            parameters: {
                type: "object",
                properties: {
                    model: { type: "string", description: "Exact provider:model value from list_available_models." },
                    reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "Optional reasoning effort supported by the selected model." },
                },
                required: ["model"],
            },
            handler: async (args: { model: string; reasoning_effort?: ReasoningEffort }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("set_session_model");
                const model = String(args.model || "").trim();
                if (!model) return "Error: model is required.";
                const reasoningEffort = args.reasoning_effort ? normalizeReasoningEffort(args.reasoning_effort) : undefined;
                if (args.reasoning_effort && !reasoningEffort) {
                    return "Error: reasoning_effort must be one of low, medium, high, xhigh.";
                }
                if (!controlBridge) return "Error: set_session_model is unavailable in this session.";
                const result = await controlBridge.setSessionModel({ model, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
                if (/model switch accepted/i.test(String(result))) {
                    turnState.pendingActions.push({
                        type: "completed",
                        content: "Model switch requested. Continuing on the selected model.",
                    });
                    return `${result}\n${acknowledgeTurnBoundary("set_session_model")}`;
                }
                if (/set_session_model failed/i.test(String(result)) || !/model switch accepted/i.test(String(result))) {
                    turnState.pendingActions.push({
                        type: "completed",
                        content: "Model switch failed. Continuing on the unchanged model.",
                    });
                    return `${result}\n${acknowledgeTurnBoundary("set_session_model")}`;
                }
                return result;
            },
        });

        const updateSessionSummaryTool = defineTool("update_session_summary", {
            description:
                "Update this session's short live summary and optionally set this session's sticky title for session lists, discovery, and the Summary tab. " +
                "Call it automatically after first meaningful work and after each notable update: changed intent, tangible progress toward the user's goal, received cross-session replies, delivered outputs, blockers, open questions, next actions, key links, schedule/delegate changes, or terminal state. " +
                "Pass title when the user asks you to rename this session or when a durable human-readable title should stick; title updates lock the title against future automatic title summarization. " +
                "Keep it concise and scannable; use compact bullets or short Markdown tables for structured progress, comparisons, rankings, decisions, or result sets instead of prose blobs. " +
                "Do not paste long transcripts, raw logs, or bulky JSON into summary fields. " +
                "Do not call it for no-op heartbeats, timer wakes, or unchanged cron cycles. " +
                "Do not pass a string for summary_state. summary_state is optional only when title is provided. " + SESSION_SUMMARY_STATE_TEMPLATE,
            parameters: {
                type: "object",
                properties: {
                    summary_state: {
                        ...SESSION_SUMMARY_STATE_SCHEMA,
                        description: "Structured live summary state. Must be an object, not a string. Missing arrays should be [].",
                    },
                    short_summary: { type: "string", description: "Optional concise summary for session lists. If omitted, summary_state.summary is used." },
                    title: { type: "string", description: "Optional sticky session title. When set, it behaves like a manual rename and prevents future automatic title changes." },
                },
            },
            handler: async (args: { summary_state?: any; short_summary?: string; title?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("update_session_summary");
                if (!controlBridge) return "Error: update_session_summary is unavailable in this session.";
                return await controlBridge.updateSessionSummary(args);
            },
        });

        const sendSessionMessageTool = defineTool("send_session_message", {
            description:
                "Send an auditable asynchronous request to another PilotSwarm session. Use list_sessions first to find the target session id. " +
                "Keep the body concise and include relevant fact/artifact links instead of transcripts. " +
                "Set expects_response=true when you need an answer back. The target must answer with reply_session_message; its normal chat transcript is not the response channel.",
            parameters: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "Target session id." },
                    subject: { type: "string", description: "Short request subject." },
                    body: { type: "string", description: "Request body, concise and self-contained." },
                    reason: { type: "string", enum: ["help", "guidance", "fact-request", "status-request", "handoff"], description: "Optional request reason." },
                    expects_response: { type: "boolean", description: "Whether a response is expected." },
                    expires_at: { type: "string", description: "Optional ISO timestamp after which the request is stale." },
                },
                required: ["session_id", "subject", "body"],
            },
            handler: async (args: { session_id: string; subject: string; body: string; reason?: string; expects_response?: boolean; expires_at?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("send_session_message");
                if (!controlBridge) return "Error: send_session_message is unavailable in this session.";
                return await controlBridge.sendSessionMessage(args);
            },
        });

        const replySessionMessageTool = defineTool("reply_session_message", {
            description:
                "Reply to a cross-session request previously received from another PilotSwarm session. " +
                "Use this whenever a [SESSION_MESSAGE ... expects_response=true] prompt asks you for an answer. " +
                "Do not only write the answer in your own chat; the sender receives it only if this tool is called.",
            parameters: {
                type: "object",
                properties: {
                    request_id: { type: "string", description: "Request id being answered." },
                    session_id: { type: "string", description: "Session id that should receive the reply." },
                    verdict: { type: "string", enum: ["answered", "declined", "blocked", "stale"], description: "Reply outcome." },
                    body: { type: "string", description: "Reply body." },
                },
                required: ["request_id", "session_id", "body"],
            },
            handler: async (args: { request_id: string; session_id: string; body: string; verdict?: string }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("reply_session_message");
                if (!controlBridge) return "Error: reply_session_message is unavailable in this session.";
                return await controlBridge.replySessionMessage(args);
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
                "If you want different reasoning power, also use only a reasoning_effort value listed for that model. " +
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
                    reasoning_effort: {
                        type: "string",
                        enum: ["low", "medium", "high", "xhigh"],
                        description: "Optional reasoning effort override from list_available_models for the selected model. If omitted, inherits the parent's reasoning effort.",
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
                    contract: {
                        type: "object",
                        description: "Optional named argument on spawn_agent; no separate contract tool exists. Example: contract={purpose:'Market scan',successCriteria:['answer with source-backed summary'],expectedFacts:[{key:'result/market-scan',required:true}],expectedArtifacts:[],validationMode:'warn',wakeOn:'material_change'}. Set wakeOn to 'any' for every update, 'material_change' (default) to suppress no-op heartbeats, or 'completion' for terminal updates only.",
                    },
                },
            },
            handler: async (args: { agent_name?: string; task?: string; model?: string; reasoning_effort?: ReasoningEffort; system_message?: string; tool_names?: string[]; title?: string; contract?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("spawn_agent");
                if (!args.agent_name && !args.task) {
                    return "Error: either agent_name or task is required.";
                }
                const reasoningEffort = args.reasoning_effort ? normalizeReasoningEffort(args.reasoning_effort) : undefined;
                if (args.reasoning_effort && !reasoningEffort) {
                    return "Error: reasoning_effort must be one of low, medium, high, xhigh.";
                }
                if (controlBridge) {
                    return await controlBridge.spawnAgent({ ...args, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
                }
                turnState.pendingActions.push({
                    type: "spawn_agent",
                    task: args.task || "",
                    model: args.model,
                    reasoningEffort,
                    systemMessage: args.system_message,
                    toolNames: args.tool_names,
                    agentName: args.agent_name,
                    title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined,
                    contract: args.contract,
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
                    contract_patch: { type: "object", description: "Optional structured patch to the child contract for follow-up work. Use 'wakeOn' here to update the parent wake policy for this child mid-flight (e.g. quiet a chatty watcher with wakeOn='material_change' or wake it up with 'any')." },
                },
                required: ["agent_id", "message"],
            },
            handler: async (args: { agent_id: string; message: string; contract_patch?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("message_agent");
                if (controlBridge) {
                    return await controlBridge.messageAgent(args);
                }
                turnState.pendingActions.push({
                    type: "message_agent",
                    agentId: args.agent_id,
                    message: args.message,
                    contractPatch: args.contract_patch,
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("check_agents");
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("wait_for_agents");
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
                        description: "Include system sessions. Default false.",
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
                    query: { type: "string", description: "Optional text search over title, agent id, owner, and summary fields." },
                    session_id: { type: "string", description: "Optional exact session id lookup." },
                    agent_id: { type: "string", description: "Optional exact named-agent id filter." },
                    state: { type: "string", description: "Optional lifecycle state filter." },
                    parent_session_id: { type: "string", description: "Optional direct parent session id filter." },
                    group_id: { type: "string", description: "Optional group id filter. Use the literal string 'null' for ungrouped sessions." },
                    include_children: { type: "boolean", description: "Include child sessions. Default false." },
                    updated_since: { type: "string", description: "Optional ISO timestamp; include sessions updated since this time." },
                    summary_updated_since: { type: "string", description: "Optional ISO timestamp; include sessions whose summary changed since this time." },
                    limit: { type: "number", description: "Maximum rows to return. Default 50, max 100." },
                },
            },
            handler: async (args: {
                include_system?: boolean;
                owner_query?: string;
                owner_kind?: string;
                query?: string;
                session_id?: string;
                agent_id?: string;
                state?: string;
                parent_session_id?: string;
                group_id?: string;
                include_children?: boolean;
                updated_since?: string;
                summary_updated_since?: string;
                limit?: number;
            }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("list_sessions");
                if (controlBridge) {
                    return await controlBridge.listSessions(args);
                }
                turnState.pendingActions.push({
                    type: "list_sessions",
                    includeSystem: args.include_system,
                    ownerQuery: args.owner_query,
                    ownerKind: args.owner_kind,
                    query: args.query,
                    sessionId: args.session_id,
                    agentId: args.agent_id,
                    state: args.state,
                    parentSessionId: args.parent_session_id,
                    groupId: args.group_id,
                    includeChildren: args.include_children,
                    updatedSince: args.updated_since,
                    summaryUpdatedSince: args.summary_updated_since,
                    limit: args.limit,
                });
                return acknowledgeTurnBoundary("list_sessions");
            },
        });

        const completeAgentTool = defineTool("complete_agent", {
            description:
                "Gracefully complete a running sub-agent. " +
                "Sends a /done command to the sub-agent, causing it to finish and send its final result back. " +
                "Sub-agents do NOT auto-terminate after their final reply, so it is YOUR responsibility to call this (or cancel_agent / delete_agent) when you no longer need a child \u2014 otherwise it stays idle and counts against your sub-agent budget.",
            parameters: {
                type: "object",
                properties: {
                    agent_id: { type: "string", description: "The sub-agent's ID (returned by spawn_agent)" },
                    result: {
                        type: "object",
                        description: "Optional structured completion result with verdict, summary, output references, blockers, and next actions.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; result?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("complete_agent");
                if (controlBridge) {
                    return await controlBridge.completeAgent(args);
                }
                turnState.pendingActions.push({ type: "complete_agent", agentId: args.agent_id, result: args.result });
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
                    partial_result: {
                        type: "object",
                        description: "Optional structured partial result for cancelled, blocked, or timed-out work.",
                    },
                },
                required: ["agent_id"],
            },
            handler: async (args: { agent_id: string; reason?: string; partial_result?: Record<string, unknown> }) => {
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("cancel_agent");
                if (controlBridge) {
                    return await controlBridge.cancelAgent(args);
                }
                turnState.pendingActions.push({ type: "cancel_agent", agentId: args.agent_id, reason: args.reason, partialResult: args.partial_result });
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
                if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary("delete_agent");
                if (controlBridge) {
                    return await controlBridge.deleteAgent(args);
                }
                turnState.pendingActions.push({ type: "delete_agent", agentId: args.agent_id, reason: args.reason });
                return acknowledgeTurnBoundary("delete_agent");
            },
        });

        const SYSTEM_TOOL_NAMES = new Set(["wait", "wait_on_worker", "cron", "cron_at", "ask_user", "report_cycle", "list_available_models", "set_session_model", "update_session_summary", "send_session_message", "reply_session_message", "spawn_agent", "message_agent", "check_agents", "wait_for_agents", "list_sessions", "complete_agent", "cancel_agent", "delete_agent"]);

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
                    if (hasTerminalTurnBoundary(turnState)) return blockedAfterTurnBoundary((t as any).name ?? "tool");
                    const augmented = { ...invocation, durableSessionId };
                    try {
                        return await (t as any).handler(args, augmented);
                    } catch (error) {
                        return failureToolResult(error);
                    }
                },
            }));

        const isReadOnlyTuner = this.config.agentIdentity === "agent-tuner";
        const mutatingSystemToolNames = new Set(["update_session_summary", "send_session_message", "reply_session_message"]);
        const systemToolsForTurn: Tool<any>[] = [
            waitTool,
            waitOnWorkerTool,
            cronTool,
            cronAtTool,
            askUserTool,
            reportCycleTool,
            listModelsTool,
            setSessionModelTool,
            updateSessionSummaryTool,
            sendSessionMessageTool,
            replySessionMessageTool,
        ].filter((tool: any) => !isReadOnlyTuner || !mutatingSystemToolNames.has(tool.name));
        const subAgentToolsForTurn = isReadOnlyTuner
            ? [checkAgentsTool, listSessionsTool]
            : [
                spawnAgentTool,
                messageAgentTool,
                checkAgentsTool,
                waitForAgentsTool,
                listSessionsTool,
                completeAgentTool,
                cancelAgentTool,
                deleteAgentTool,
            ];

        const allTools: Tool<any>[] = [
            ...wrappedUserTools,
            ...systemToolsForTurn,
            ...subAgentToolsForTurn,
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
        const textEmittedToolCallRef: { current: { toolName: string; rawContent: string } | null } = { current: null };

        // Streaming progress + turn timing state.
        // Token-level deltas (`assistant.message_delta`,
        // `assistant.streaming_delta`, `assistant.reasoning_delta`) stay
        // ephemeral — see EPHEMERAL_TYPES in session-proxy.ts. We collapse
        // them into a coarse `assistant.streaming_progress` heartbeat so the
        // activity pane has a live signal during long generations without
        // flooding CMS. Also augment `assistant.turn_end` with `durationMs`
        // computed from the matching `assistant.turn_start` so the activity
        // formatter can render "[turn end] 4m 12s, 1843 chars".
        let turnStartedAtMs: number | null = null;
        let streamingDeltaCount = 0;
        let streamingDeltaChars = 0;
        // Note: we used to emit a synthetic `assistant.streaming_progress`
        // heartbeat into CMS for the activity pane. The user found those
        // rows noisy compared to the actual reasoning snapshots, so the
        // synthetic emission was removed. The counters are still tracked
        // so we can stamp `assistant.turn_end.data.streamingChars` /
        // `streamingDeltas` for post-hoc analysis.
        const flushStreamingProgress = (_force: boolean) => {
            // Intentionally a no-op. Kept as a hook so existing call sites
            // (turn_end / session.idle / per-delta) compile without churn,
            // and so re-enabling a heartbeat is a one-line change.
        };

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
            // Streaming makes reasoning_delta arrive constantly. Be aggressive
            // about throttling synthetic snapshots: only emit on force (turn
            // boundary), or when the content has grown by >=200 chars and
            // 5s have elapsed since the last publish.
            if (!force && (lengthDelta < 200 || now - lastReasoningPublishAt < 5000)) return;

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
            // Only forward to CMS on force (turn boundaries). Mid-stream
            // synthetic snapshots stay in-memory for the runTurn() return
            // value; they are noise in the activity pane.
            if (force && opts?.onEvent) {
                try { opts.onEvent(captured); } catch {}
            }
        }

        const turnComplete = new Promise<void>((resolve, reject) => {
            // Hang-escalation hook: forceSettleTurn() resolves this promise when
            // the SDK never fires session.idle (see stop-turn plan, edge E3).
            this.settleTurnResolver = resolve;
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
                    if (isEmptyAssistantTranscriptEvent(eventType, eventData)) {
                        return;
                    }

                    if (eventType === "assistant.message") {
                        const content = extractAssistantMessageContent({ data: eventData });
                        const textToolCall = detectTextEmittedToolCall(content);
                        if (textToolCall) {
                            textEmittedToolCallRef.current = textToolCall;
                            return;
                        }
                        finalContent = content ?? finalContent;
                        publishReasoningSnapshot("assistant.message", true);
                    }

                    // Track turn boundaries so we can stamp turn_end with a
                    // durationMs and the streaming counters.
                    if (eventType === "assistant.turn_start") {
                        turnStartedAtMs = Date.now();
                        streamingDeltaCount = 0;
                        streamingDeltaChars = 0;
                    } else if (eventType === "assistant.turn_end") {
                        flushStreamingProgress(true);
                        if (turnStartedAtMs && eventData && typeof eventData === "object") {
                            (eventData as Record<string, unknown>).durationMs = Date.now() - turnStartedAtMs;
                            (eventData as Record<string, unknown>).streamingDeltas = streamingDeltaCount;
                            (eventData as Record<string, unknown>).streamingChars = streamingDeltaChars;
                        }
                        turnStartedAtMs = null;
                    } else if (eventType === "assistant.message_delta" || eventType === "assistant.streaming_delta") {
                        streamingDeltaCount += 1;
                        const deltaText = (eventData && typeof eventData === "object")
                            ? ((eventData as any).deltaContent ?? (eventData as any).delta ?? (eventData as any).content ?? "")
                            : "";
                        if (typeof deltaText === "string") streamingDeltaChars += deltaText.length;
                        // Don't record the delta itself in collectedEvents —
                        // it's pure noise for replay. Only emit the throttled
                        // synthetic when we actually received text; some
                        // deltas carry no content and would render as
                        // "[streaming] 4s · 0 chars".
                        if (streamingDeltaChars > 0) flushStreamingProgress(false);
                        if (opts?.onEvent) {
                            // Forward the raw delta too in case onDelta-style
                            // consumers want it; they're already filtered out
                            // of CMS persistence by EPHEMERAL_TYPES.
                            try { opts.onEvent(captured); } catch {}
                        }
                        return;
                    }

                    // Dedup real `assistant.reasoning` events from the SDK.
                    // With streaming enabled the SDK can re-emit the same
                    // reasoning snapshot multiple times in a burst, which
                    // would otherwise flood CMS and the activity pane with
                    // visually-identical lines. Drop the event if its content
                    // matches the last reasoning snapshot we already
                    // persisted.
                    if (eventType === "assistant.reasoning") {
                        const content = String(extractReasoningText(eventData) || "").trim();
                        if (content && content === lastPublishedReasoning) {
                            return;
                        }
                        if (content) {
                            lastPublishedReasoning = content;
                            lastReasoningPublishAt = Date.now();
                        }
                    }

                    collectedEvents.push(captured);
                    // Fire immediately so callers can write to CMS in real-time
                    if (opts?.onEvent) {
                        try { opts.onEvent(captured); } catch {}
                    }
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
                    flushStreamingProgress(true);
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

        // Re-armable idle waiter used by the tool-call-as-text guard to wait for
        // the model's response to a mid-turn correction without tearing down the
        // event subscriptions set up above.
        const waitForNextIdle = (): Promise<void> => new Promise<void>((resolve) => {
            const unsub = this.copilotSession.on("session.idle", () => {
                flushStreamingProgress(true);
                publishReasoningSnapshot("session.idle", true);
                unsub();
                resolve();
            });
            unsubscribers.push(unsub);
        });

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

            // ── Guard: tool call emitted as text instead of executed ──────────
            // If the model typed a tool call as `<invoke .../>` text rather than
            // calling it, that call did not run. Re-prompt it (bounded) to
            // actually invoke the tool so a consequential call is never silently
            // dropped. If a control tool already scheduled a turn boundary, we
            // still return an error rather than accepting a transcript that
            // implied another unexecuted tool side effect.
            let textToolCallCorrections = 0;
            while (
                textToolCallCorrections < MAX_TEXT_TOOL_CALL_CORRECTIONS &&
                !hasTerminalTurnBoundary(turnState) &&
                textEmittedToolCallRef.current
            ) {
                const offendingTool = textEmittedToolCallRef.current.toolName;
                const rawContent = textEmittedToolCallRef.current.rawContent;
                textEmittedToolCallRef.current = null;
                textToolCallCorrections++;
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.tool_call_as_text",
                    data: { toolName: offendingTool, rawContent, attempt: textToolCallCorrections, sessionId: this.sessionId },
                };
                collectedEvents.push(diagnostic);
                if (opts?.onEvent) { try { opts.onEvent(diagnostic); } catch {} }

                finalContent = undefined;
                const nextIdle = waitForNextIdle();
                await this.copilotSession.send({ prompt: buildTextEmittedToolCallCorrection(offendingTool) });
                if (timeoutPromise) {
                    await Promise.race([nextIdle, timeoutPromise]);
                } else {
                    await nextIdle;
                }
            }

            if (textEmittedToolCallRef.current) {
                const diagnostic: CapturedEvent = {
                    eventType: "runtime.tool_call_as_text",
                    data: { toolName: textEmittedToolCallRef.current.toolName, rawContent: textEmittedToolCallRef.current.rawContent, final: true, sessionId: this.sessionId },
                };
                collectedEvents.push(diagnostic);
                if (opts?.onEvent) { try { opts.onEvent(diagnostic); } catch {} }
                const message = buildTextEmittedToolCallCorrection(textEmittedToolCallRef.current.toolName);
                return {
                    type: "error",
                    message,
                    events: collectedEvents,
                } as any;
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
                case "completed":
                    return { ...firstAction, events: collectedEvents, queuedActions };
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
            ...(turnState.cycleReport ? { cycleReport: turnState.cycleReport } : {}),
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
        if (config.reasoningEffort !== undefined) this.config.reasoningEffort = config.reasoningEffort;
        if (config.tools !== undefined) this.config.tools = config.tools;
        if (config.systemMessage !== undefined) this.config.systemMessage = config.systemMessage;
        if (config.turnSystemPrompt !== undefined) this.config.turnSystemPrompt = config.turnSystemPrompt;
        if (config.waitThreshold !== undefined) this.config.waitThreshold = config.waitThreshold;
    }

    requiresModelRebind(config: Partial<ManagedSessionConfig>): boolean {
        const currentModel = this.config.model;
        const nextModel = config.model ?? this.config.model;
        const currentReasoningEffort = this.config.reasoningEffort ?? null;
        const nextReasoningEffort = config.reasoningEffort !== undefined
            ? config.reasoningEffort ?? null
            : this.config.reasoningEffort ?? null;
        return Boolean(
            (currentModel || nextModel)
            && (currentModel !== nextModel || currentReasoningEffort !== nextReasoningEffort)
        );
    }

    /** Get the underlying CopilotSession (for direct access when needed). */
    getCopilotSession(): CopilotSession {
        return this.copilotSession;
    }
}
