import type { Tool, SessionConfig } from "@github/copilot-sdk";
import type { SessionStateStore } from "./session-store.js";

// ─── Turn Result ─────────────────────────────────────────────────
// What ManagedSession.runTurn() returns to the orchestration.

export type TurnAction =
    | { type: "wait"; seconds: number; reason: string; content?: string; events?: CapturedEvent[] }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] }
    | { type: "spawn_agent"; task: string; model?: string; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; content?: string; events?: CapturedEvent[] }
    | { type: "message_agent"; agentId: string; message: string; events?: CapturedEvent[] }
    | { type: "check_agents"; events?: CapturedEvent[] }
    | { type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] }
    | { type: "list_sessions"; events?: CapturedEvent[] }
    | { type: "complete_agent"; agentId: string; events?: CapturedEvent[] }
    | { type: "cancel_agent"; agentId: string; reason?: string; events?: CapturedEvent[] }
    | { type: "delete_agent"; agentId: string; reason?: string; events?: CapturedEvent[] };

type QueuedTurnActionCarrier = {
    queuedActions?: TurnAction[];
};

export type TurnResult =
    | { type: "completed"; content: string; events?: CapturedEvent[] }
    | ({ type: "wait"; seconds: number; reason: string; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "spawn_agent"; task: string; model?: string; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "message_agent"; agentId: string; message: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "check_agents"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "list_sessions"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "complete_agent"; agentId: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cancel_agent"; agentId: string; reason?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "delete_agent"; agentId: string; reason?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | { type: "cancelled" }
    | { type: "error"; message: string; events?: CapturedEvent[] };

/** A raw event captured from CopilotSession.on() during a turn. */
export interface CapturedEvent {
    eventType: string;
    data: unknown;
}

// ─── Turn Options ────────────────────────────────────────────────

export interface TurnOptions {
    onDelta?: (delta: string) => void;
    onToolStart?: (name: string, args: any) => void;
    /** Called for every event as it fires during the turn. */
    onEvent?: (event: CapturedEvent) => void;
    /** Model summary text for the list_available_models tool. */
    modelSummary?: string;
}

// ─── Session Config ──────────────────────────────────────────────

/** Serializable config — travels through duroxide (no functions). */
export interface SerializableSessionConfig {
    model?: string;
    systemMessage?: string | { mode: "append" | "replace"; content: string };
    workingDirectory?: string;
    /** Wait threshold in seconds. Waits shorter than this sleep in-process. */
    waitThreshold?: number;
    /**
     * Names of tools registered on the worker via `worker.registerTools()`.
     * Serializable — travels through duroxide. The worker resolves these
     * names to actual Tool objects from its registry at activity execution time.
     */
    toolNames?: string[];
}

/** Full config — includes non-serializable fields (tools, hooks). Stays in memory. */
export interface ManagedSessionConfig extends SerializableSessionConfig {
    tools?: Tool<any>[];
    hooks?: SessionConfig["hooks"];
    /** Turn timeout in milliseconds. 0 or undefined = no timeout. */
    turnTimeoutMs?: number;
}

// ─── Session Status ──────────────────────────────────────────────

export type PilotSwarmSessionStatus =
    | "pending"
    | "running"
    | "idle"
    | "waiting"
    | "input_required"
    | "completed"
    | "failed"
    | "error";

// ─── Session Info ────────────────────────────────────────────────

export interface PilotSwarmSessionInfo {
    sessionId: string;
    status: PilotSwarmSessionStatus;
    /** LLM model used for this session. */
    model?: string;
    /** LLM-generated 3-5 word summary of the session. */
    title?: string;
    createdAt: Date;
    updatedAt: Date;
    pendingQuestion?: { question: string; choices?: string[]; allowFreeform?: boolean };
    waitingUntil?: Date;
    waitReason?: string;
    result?: string;
    error?: string;
    iterations: number;
    /** If this is a sub-agent session, the parent session's ID. */
    parentSessionId?: string;
    /** Whether this is a system session (e.g. Sweeper Agent). Cannot be deleted. */
    isSystem?: boolean;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId?: string;
    /** Splash banner (blessed markup) from the agent definition. */
    splash?: string;
}

// ─── Orchestration Input ─────────────────────────────────────────

export interface OrchestrationInput {
    sessionId: string;
    config: SerializableSessionConfig;
    // Carried across continueAsNew
    iteration?: number;
    responseVersion?: number;
    commandVersion?: number;
    affinityKey?: string;
    needsHydration?: boolean;
    blobEnabled?: boolean;
    prompt?: string;
    // Thresholds
    dehydrateThreshold?: number;
    idleTimeout?: number;
    inputGracePeriod?: number;
    /** Timestamp (ms) when the next title summarization should fire. 0 = not yet scheduled. */
    nextSummarizeAt?: number;
    /** How many consecutive retries have been attempted for the current prompt. */
    retryCount?: number;
    /** The user's original task-defining prompt, preserved to survive LLM truncation. */
    taskContext?: string;
    /** Original system message before task context injection (avoids double-appending). */
    baseSystemMessage?: string | { mode: "append" | "replace"; content: string };
    /** Seconds between periodic checkpoints (blob upload without losing session pin). -1 = disabled. */
    checkpointInterval?: number;
    /** Custom message prepended to the user prompt on rehydration (after worker death). */
    rehydrationMessage?: string;

    // ─── Sub-agent state ─────────────────────────────────────
    /** Tracked sub-agents spawned by this orchestration. Carried across continueAsNew. */
    subAgents?: SubAgentEntry[];
    /** Durable queue of additional tool actions emitted in the same LLM turn. */
    pendingToolActions?: TurnAction[];
    /** One already-dequeued inbound message to replay first after continueAsNew. */
    pendingMessage?: unknown;
    /** If this is a sub-agent, the parent session ID (for sending updates back via SDK). */
    parentSessionId?: string;
    /** @deprecated Use parentSessionId. Kept for backward compat with frozen orchestration versions. */
    parentOrchId?: string;
    /** Current nesting level (0 = root, 1 = child, 2 = grandchild). Used to enforce max depth. */
    nestingLevel?: number;
    /** Whether this is a system session (e.g. Sweeper Agent). System sessions skip title summarization. */
    isSystem?: boolean;
}

/** A sub-agent entry tracked in the parent orchestration's state. */
export interface SubAgentEntry {
    /** The child orchestration ID (e.g. "session-<guid>"). */
    orchId: string;
    /** The session ID portion. */
    sessionId: string;
    /** Short description of the task assigned to this sub-agent. */
    task: string;
    /** Last known status of the sub-agent. */
    status: "running" | "completed" | "failed" | "cancelled";
    /** Final result content (set when status becomes completed). */
    result?: string;
}

// ─── Client Options ──────────────────────────────────────────────

// ─── Worker Options ──────────────────────────────────────────────

export interface PilotSwarmWorkerOptions {
    store: string;
    /** GitHub token. Required unless a custom `provider` is specified. */
    githubToken?: string;
    logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
    waitThreshold?: number;
    maxSessionsPerRuntime?: number;
    sessionIdleTimeoutMs?: number;
    workerNodeId?: string;
    /** Azure Blob Storage connection string for the built-in blob-backed session store. */
    blobConnectionString?: string;
    /** Blob container name for the built-in blob-backed session store. */
    blobContainer?: string;
    /** Optional session state store. When set, enables durable session dehydration without Azure Blob Storage. */
    sessionStore?: SessionStateStore;

    /**
     * Turn timeout in milliseconds. If a single LLM turn takes longer than this,
     * it is aborted. 0 or undefined = no timeout (default).
     */
    turnTimeoutMs?: number;

    /**
     * Base directory for local session state files.
     * Default: `~/.copilot/session-state`.
     */
    sessionStateDir?: string;

    /**
     * Optional trace callback for startup diagnostics.
     * If not provided, trace messages are discarded.
     */
    traceWriter?: (msg: string) => void;

    /**
     * Custom LLM provider (BYOK — Bring Your Own Key).
     * When specified, uses this API endpoint instead of the GitHub Copilot API.
     * Eliminates the need for a GitHub token.
     *
     * Supports OpenAI-compatible, Azure OpenAI, and Anthropic endpoints.
     */
    provider?: {
        /** Provider type. Defaults to "openai" for generic OpenAI-compatible APIs. */
        type?: "openai" | "azure" | "anthropic";
        /** API endpoint URL (e.g. https://my-resource.openai.azure.com/openai/deployments/gpt-4.1-mini) */
        baseUrl: string;
        /** API key. Optional for local providers like Ollama. */
        apiKey?: string;
        /** Azure-specific options. */
        azure?: { apiVersion?: string };
    };

    /**
     * PostgreSQL schema name for duroxide orchestration tables.
     * Default: `"duroxide"`. Change this to run multiple independent
     * deployments on the same database.
     */
    duroxideSchema?: string;

    /**
     * PostgreSQL schema name for the session catalog (CMS) tables.
     * Default: `"copilot_sessions"`. Change this to isolate session
     * data across deployments sharing the same database.
     */
    cmsSchema?: string;

    // ─── Building Blocks ─────────────────────────────────────
    // Workers own the building blocks. Clients are thin proxies.

    /** Base system message for all sessions on this worker. */
    systemMessage?: string;

    /**
     * Plugin directories to load at startup.
     * Each directory can contain:
     *   - `skills/` subdirectories with `SKILL.md` files
     *   - `agents/` directory with `.agent.md` files
     *   - `.mcp.json` file with MCP server configs
     *   - `plugin.json` manifest (optional metadata)
     *
     * The worker reads these at startup and passes their contents
     * through the SDK's `skillDirectories`, `customAgents`, and
     * `mcpServers` session config fields.
     */
    pluginDirs?: string[];

    /**
     * Additional skill directories (beyond plugins).
     * Each directory should contain subdirectories with `SKILL.md` files.
     * These are passed directly to the SDK's `skillDirectories` config.
     */
    skillDirectories?: string[];

    /**
     * Additional custom agents (beyond plugins).
     * Passed directly to the SDK's `customAgents` config.
     */
    customAgents?: Array<{
        name: string;
        description?: string;
        prompt: string;
        tools?: string[] | null;
    }>;

    /**
     * Additional MCP server configs (beyond plugins).
     * Passed directly to the SDK's `mcpServers` config.
     */
    mcpServers?: Record<string, any>;

    /**
     * Path to a `model_providers.json` file.
     * Defines multiple LLM providers (GitHub Copilot, Azure OpenAI, OpenAI, Anthropic)
     * each with their own endpoints, API keys, and available models.
     *
     * If not specified, auto-discovers `.model_providers.json` in cwd or /app/.
     * Falls back to legacy env vars (LLM_ENDPOINT, GITHUB_TOKEN) if no file found.
     */
    modelProvidersPath?: string;

    /**
     * Disable SDK-bundled management agents (pilotswarm, resourcemgr, sweeper).
     * Default: false. Set to true for headless/minimal deployments.
     */
    disableManagementAgents?: boolean;
}

// ─── Client Options ──────────────────────────────────────────────

export interface PilotSwarmClientOptions {
    /** Store URL (postgres:// or sqlite://). */
    store: string;
    /** Enables durable session-store paths in the orchestration. Works with Azure blob or any custom session store configured on workers. */
    blobEnabled?: boolean;
    waitThreshold?: number;
    dehydrateThreshold?: number;
    dehydrateOnInputRequired?: number;
    dehydrateOnIdle?: number;

    /**
     * Optional trace callback for startup diagnostics.
     * If not provided, trace messages are discarded.
     */
    traceWriter?: (msg: string) => void;

    /** Seconds between periodic checkpoints (blob upload without losing session pin). -1 = disabled. */
    checkpointInterval?: number;

    /** Custom message prepended to the user prompt on rehydration (after worker death). */
    rehydrationMessage?: string;

    /**
     * PostgreSQL schema name for duroxide orchestration tables.
     * Default: `"duroxide"`. Must match the worker's `duroxideSchema`.
     */
    duroxideSchema?: string;

    /**
     * PostgreSQL schema name for the session catalog (CMS) tables.
     * Default: `"copilot_sessions"`. Must match the worker's `cmsSchema`.
     */
    cmsSchema?: string;
}

// ─── User Input ──────────────────────────────────────────────────

export interface UserInputRequest {
    question: string;
    choices?: string[];
    allowFreeform?: boolean;
}

export interface UserInputResponse {
    answer: string;
    wasFreeform: boolean;
}

export type UserInputHandler = (
    request: UserInputRequest,
    invocation: { sessionId: string }
) => Promise<UserInputResponse> | UserInputResponse;

// ─── Command Messages ────────────────────────────────────────────

export interface CommandMessage {
    type: "cmd";
    cmd: string;
    args?: Record<string, unknown>;
    id: string;
}

export interface CommandResponse {
    id: string;
    cmd: string;
    result?: unknown;
    error?: string;
}

// ─── KV-Backed Response Channel ────────────────────────────────

export const RESPONSE_VERSION_KEY = "meta.responseVersion";
export const COMMAND_VERSION_KEY = "meta.commandVersion";
export const RESPONSE_LATEST_KEY = "response.latest";

export function commandResponseKey(cmdId: string): string {
    return `command.response.${cmdId}`;
}

export interface SessionResponsePayload {
    schemaVersion: 1;
    version: number;
    iteration: number;
    type: "completed" | "wait" | "input_required";
    content?: string;
    question?: string;
    choices?: string[];
    allowFreeform?: boolean;
    waitReason?: string;
    waitSeconds?: number;
    waitStartedAt?: number;
    emittedAt: number;
    model?: string;
}

export interface SessionCommandResponse extends CommandResponse {
    schemaVersion: 1;
    version: number;
    emittedAt: number;
}

export interface SessionStatusSignal {
    status: PilotSwarmSessionStatus;
    iteration: number;
    responseVersion?: number;
    commandVersion?: number;
    commandId?: string;
    cmdProcessing?: string;
    waitReason?: string;
    waitSeconds?: number;
    waitStartedAt?: number;
    error?: string;
    retriesExhausted?: boolean;
}
