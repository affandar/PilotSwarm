import type { Tool, SessionConfig } from "@github/copilot-sdk";

// ─── Turn Result ─────────────────────────────────────────────────
// What ManagedSession.runTurn() returns to the orchestration.

export type TurnResult =
    | { type: "completed"; content: string; events?: CapturedEvent[] }
    | { type: "wait"; seconds: number; reason: string; content?: string; events?: CapturedEvent[] }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] }
    | { type: "spawn_agent"; task: string; systemMessage?: string; toolNames?: string[]; content?: string; events?: CapturedEvent[] }
    | { type: "message_agent"; agentId: string; message: string; events?: CapturedEvent[] }
    | { type: "check_agents"; events?: CapturedEvent[] }
    | { type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] }
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
}

// ─── Session Status ──────────────────────────────────────────────

export type DurableSessionStatus =
    | "pending"
    | "running"
    | "idle"
    | "waiting"
    | "input_required"
    | "completed"
    | "failed"
    | "error";

// ─── Session Info ────────────────────────────────────────────────

export interface DurableSessionInfo {
    sessionId: string;
    status: DurableSessionStatus;
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
}

// ─── Orchestration Input ─────────────────────────────────────────

export interface OrchestrationInput {
    sessionId: string;
    config: SerializableSessionConfig;
    // Carried across continueAsNew
    iteration?: number;
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
    /** If this is a sub-agent, the parent orchestration ID (for sending updates back). */
    parentOrchId?: string;
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
    status: "running" | "completed" | "failed";
    /** Final result content (set when status becomes completed). */
    result?: string;
}

// ─── Client Options ──────────────────────────────────────────────

// ─── Worker Options ──────────────────────────────────────────────

export interface DurableCopilotWorkerOptions {
    store: string;
    githubToken: string;
    logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
    waitThreshold?: number;
    maxSessionsPerRuntime?: number;
    sessionIdleTimeoutMs?: number;
    workerNodeId?: string;
    blobConnectionString?: string;
    blobContainer?: string;

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
}

// ─── Client Options ──────────────────────────────────────────────

export interface DurableCopilotClientOptions {
    /** Store URL (postgres:// or sqlite://). */
    store: string;
    blobEnabled?: boolean;
    waitThreshold?: number;
    dehydrateThreshold?: number;
    dehydrateOnInputRequired?: number;
    dehydrateOnIdle?: number;

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
