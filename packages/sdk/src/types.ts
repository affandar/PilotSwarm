import type { Tool, SessionConfig } from "@github/copilot-sdk";
import type { SessionStateStore } from "./session-store.js";
import type { ReasoningEffort } from "./model-providers.js";

export const SESSION_STATE_MISSING_PREFIX = "SESSION_STATE_MISSING:";

// ─── Turn Result ─────────────────────────────────────────────────
// What ManagedSession.runTurn() returns to the orchestration.

export type TurnAction =
    | { type: "wait"; seconds: number; reason: string; preserveWorkerAffinity?: boolean; content?: string; events?: CapturedEvent[] }
    | { type: "cron"; action: "set"; intervalSeconds: number; reason: string; events?: CapturedEvent[] }
    | { type: "cron"; action: "cancel"; events?: CapturedEvent[] }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] }
    | { type: "spawn_agent"; task: string; model?: string; reasoningEffort?: ReasoningEffort; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; title?: string; content?: string; events?: CapturedEvent[] }
    | { type: "message_agent"; agentId: string; message: string; events?: CapturedEvent[] }
    | { type: "check_agents"; events?: CapturedEvent[] }
    | { type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] }
    | { type: "list_sessions"; includeSystem?: boolean; ownerQuery?: string; ownerKind?: string; events?: CapturedEvent[] }
    | { type: "complete_agent"; agentId: string; events?: CapturedEvent[] }
    | { type: "cancel_agent"; agentId: string; reason?: string; events?: CapturedEvent[] }
    | { type: "delete_agent"; agentId: string; reason?: string; events?: CapturedEvent[] };

type QueuedTurnActionCarrier = {
    queuedActions?: TurnAction[];
};

export type TurnResult =
    | ({ type: "completed"; content: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "wait"; seconds: number; reason: string; preserveWorkerAffinity?: boolean; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron"; action: "set"; intervalSeconds: number; reason: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron"; action: "cancel"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "spawn_agent"; task: string; model?: string; reasoningEffort?: ReasoningEffort; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; title?: string; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "message_agent"; agentId: string; message: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "check_agents"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "list_sessions"; includeSystem?: boolean; ownerQuery?: string; ownerKind?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
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
    /** Internal: startup/bootstrap turn that should not be recorded as a user message. */
    bootstrap?: boolean;
    /** Require the Copilot SDK to use a specific tool during this turn. */
    requiredTool?: string;
    /** Worker-owned inline implementations for non-suspending control tools. */
    controlToolBridge?: {
        spawnAgent(args: {
            agent_name?: string;
            task?: string;
            model?: string;
            reasoning_effort?: ReasoningEffort;
            system_message?: string;
            tool_names?: string[];
            title?: string;
        }): Promise<string>;
        messageAgent(args: { agent_id: string; message: string }): Promise<string>;
        checkAgents(): Promise<string>;
        resolveWaitForAgents(agentIds?: string[]): Promise<string[]>;
        listSessions(args?: {
            include_system?: boolean;
            owner_query?: string;
            owner_kind?: string;
        }): Promise<string>;
        completeAgent(args: { agent_id: string }): Promise<string>;
        cancelAgent(args: { agent_id: string; reason?: string }): Promise<string>;
        deleteAgent(args: { agent_id: string; reason?: string }): Promise<string>;
    };
}

// ─── Session Config ──────────────────────────────────────────────

/** Serializable config — travels through duroxide (no functions). */
export interface SerializableSessionConfig {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    systemMessage?: string | { mode: "append" | "replace"; content: string };
    /** Internal: orchestration-generated system guidance for the next turn only. */
    turnSystemPrompt?: string;
    workingDirectory?: string;
    /** Wait threshold in seconds. Waits shorter than this sleep in-process. */
    waitThreshold?: number;
    /** Internal: name of the bound agent definition whose prompt should be layered into this session. */
    boundAgentName?: string;
    /** Internal: selects how framework, app, and agent prompts compose for this session. */
    promptLayering?: {
        kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent";
    };
    /**
     * Names of tools registered on the worker via `worker.registerTools()`.
     * Serializable — travels through duroxide. The worker resolves these
     * names to actual Tool objects from its registry at activity execution time.
     */
    toolNames?: string[];
    /**
     * Internal: identity of the bound agent for namespace access control.
     * Set from the agent definition's `id` field. Used by fact tool handlers
     * to enforce knowledge pipeline namespace restrictions.
     */
    agentIdentity?: string;
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
    | "cancelled"
    | "failed"
    | "error";

export interface SessionCompactionSnapshot {
    state: "idle" | "running" | "succeeded" | "failed";
    startedAt?: number;
    completedAt?: number;
    error?: string;
    preCompactionTokens?: number;
    postCompactionTokens?: number;
    preCompactionMessagesLength?: number;
    messagesRemoved?: number;
    tokensRemoved?: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
}

export interface SessionContextUsage {
    tokenLimit: number;
    currentTokens: number;
    utilization: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
    isInitial?: boolean;
    lastInputTokens?: number;
    lastOutputTokens?: number;
    lastCacheReadTokens?: number;
    lastCacheWriteTokens?: number;
    updatedAt?: number;
    compaction?: SessionCompactionSnapshot;
}

export interface SessionOwnerInfo {
    provider: string;
    subject: string;
    email?: string | null;
    displayName?: string | null;
}

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
    cronActive?: boolean;
    cronInterval?: number;
    cronReason?: string;
    result?: string;
    error?: string;
    iterations: number;
    /** If this is a sub-agent session, the parent session's ID. */
    parentSessionId?: string;
    /** Whether this is a system session (e.g. Sweeper Agent). Cannot be deleted. */
    isSystem?: boolean;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId?: string;
    /** Splash banner (terminal markup) from the agent definition. */
    splash?: string;
    /** Authenticated user associated with this session when available. */
    owner?: SessionOwnerInfo;
    /** Latest known context-window usage snapshot for this session. */
    contextUsage?: SessionContextUsage;
}

export interface CronSchedule {
    intervalSeconds: number;
    reason: string;
}

// ─── Orchestration Input ─────────────────────────────────────────

export interface OrchestrationInput {
    sessionId: string;
    config: SerializableSessionConfig;
    /**
     * Version of the orchestration handler that produced this input snapshot.
     * New starts set this to the latest version; continue-as-new handoffs stamp
     * the source version before targeting the shared latest handler.
     */
    sourceOrchestrationVersion?: string;
    // Carried across continueAsNew
    iteration?: number;
    responseVersion?: number;
    commandVersion?: number;
    affinityKey?: string;
    /** Internal: preserve the current worker affinity across the next hydration attempt. */
    preserveAffinityOnHydrate?: boolean;
    needsHydration?: boolean;
    blobEnabled?: boolean;
    prompt?: string;
    /** Internal: require the next prompt turn to use a specific tool if available. */
    requiredTool?: string;
    /** Internal: system guidance carried alongside the next prompt without becoming user text. */
    systemPrompt?: string;
    /** Internal: pending prompt is a bootstrap message, not a user-authored prompt. */
    bootstrapPrompt?: boolean;
    // Thresholds
    /** Seconds above which wait/cron timers proactively dehydrate. Default: 29. */
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
    /** Safety net: true if the previous turn was a forgotten-timer nudge. Prevents infinite nudge loops. */
    forgottenTimerNudged?: boolean;
    /** Active recurring schedule set by the cron tool. */
    cronSchedule?: CronSchedule;
    /** Latest known context-window usage snapshot captured from session events. */
    contextUsage?: SessionContextUsage;

    // ─── Flat event loop state (v1.0.32+) ───────────────────
    /** Timer state carried across continueAsNew for the flat event loop. */
    activeTimerState?: {
        remainingMs: number;
        reason: string;
        type: "wait" | "cron" | "idle" | "agent-poll" | "input-grace";
        originalDurationMs?: number;
        shouldRehydrate?: boolean;
        waitPlan?: { shouldDehydrate: boolean; resetAffinityOnDehydrate: boolean; preserveAffinityOnHydrate: boolean };
        content?: string;
        question?: string;
        choices?: string[];
        allowFreeform?: boolean;
        agentIds?: string[];
    };
    /** Agent IDs being waited on (for wait_for_agents across CAN). v1.0.32+. */
    waitingForAgentIds?: string[];
    /** Pending input_required question context (for answer routing after CAN). v1.0.32+. */
    pendingInputQuestion?: { question: string; choices?: string[]; allowFreeform?: boolean };
    /** Saved interrupted wait timer. The orchestration auto-resumes after the LLM responds. v1.0.32+. */
    interruptedWaitTimer?: {
        remainingSec: number;
        reason: string;
        shouldRehydrate: boolean;
        waitPlan?: { shouldDehydrate: boolean; resetAffinityOnDehydrate: boolean; preserveAffinityOnHydrate: boolean };
    };
    /** Saved interrupted cron timer. The orchestration auto-resumes the remaining time unless cron is explicitly reset. */
    interruptedCronTimer?: {
        remainingMs: number;
        reason: string;
        originalDurationMs?: number;
        shouldRehydrate?: boolean;
    };
    /** Buffered child updates waiting to be coalesced into a single parent turn. */
    pendingChildDigest?: {
        startedAtMs: number;
        ready?: boolean;
        updates: Array<{
            sessionId: string;
            updateType: string;
            content?: string;
            observedAtMs: number;
        }>;
    };
    /** Graceful shutdown state carried across continueAsNew while child sessions drain. */
    pendingShutdown?: {
        mode: "done" | "cancel" | "delete";
        reason: string;
        startedAtMs: number;
        deadlineAtMs: number;
        targetAgentIds: string[];
        commandId?: string;
    };

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
    /** Agent definition ID bound to this session (e.g. "supervisor"). Used for policy validation. */
    agentId?: string;
    /** Session creation policy (loaded from session-policy.json). */
    sessionPolicy?: SessionPolicy;
    /** Names of all loaded non-system agents. Used by orchestration to validate policy. */
    allowedAgentNames?: string[];
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
    status: "running" | "waiting" | "completed" | "failed" | "cancelled";
    /** Final result content (set when status becomes completed). */
    result?: string;
    /** Named agent ID (e.g. "sweeper", "resourcemgr") for dedup guards. */
    agentId?: string;
}

// ─── Session Policy ──────────────────────────────────────────────

/**
 * App-level session creation policy. Loaded from `session-policy.json`
 * in a plugin directory. Controls which sessions can be created and deleted.
 */
export interface SessionPolicy {
    version: 1;
    creation?: {
        /** "allowlist" = only loaded non-system agents; "open" = current behavior. Default: "open". */
        mode?: "allowlist" | "open";
        /** Whether generic (blank, no agent) sessions are allowed. Default: true. */
        allowGeneric?: boolean;
        /** Default agent name for TUI single-step creation. */
        defaultAgent?: string;
    };
    deletion?: {
        /** Whether system sessions are protected from deletion. Default: true. */
        protectSystem?: boolean;
    };
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
    /**
     * Account-level URL (`https://<account>.blob.core.windows.net`) used
     * when running with `useManagedIdentity: true`. Ignored otherwise.
     */
    blobAccountUrl?: string;
    /**
     * Opt into managed-identity auth for Azure Blob Storage. When `true`,
     * `blobAccountUrl` is required and `blobConnectionString` is ignored;
     * the worker uses `DefaultAzureCredential` (workload identity in AKS,
     * `az login` / env-var creds locally). SAS URL generation will throw
     * `NotSupportedInManagedIdentityMode` — callers must proxy artifact
     * downloads through the worker.
     *
     * Also routes CMS + facts pools through the AAD pg-pool factory:
     * tokens are minted via `DefaultAzureCredential` and pg invokes the
     * `password` callback on every new physical connection. Duroxide's
     * orchestration store still uses the password URL in `store` because
     * its `PostgresProvider` has no token-callback hook upstream.
     */
    useManagedIdentity?: boolean;
    /**
     * Override URL used by CMS + facts pools. Defaults to `store`. When
     * `useManagedIdentity` is `true` this should be the passwordless URL
     * whose `user@` segment is the AAD principal name registered as a
     * Postgres administrator.
     */
    cmsFactsDatabaseUrl?: string;
    /**
     * AAD principal name (UAMI display name / SP appId / user UPN) used
     * as the Postgres role when authenticating via token. Defaults to
     * the `user` field parsed from `cmsFactsDatabaseUrl`. Only consulted
     * when `useManagedIdentity` is `true`.
     */
    aadDbUser?: string;
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

    /**
     * PostgreSQL schema name for the built-in facts tables.
     * Default: `"pilotswarm_facts"`. Change this to isolate durable
     * fact storage across deployments sharing the same database.
     */
    factsSchema?: string;

    // ─── Building Blocks ─────────────────────────────────────
    // Workers own the building blocks. Clients are thin proxies.

    /**
     * Inline app-level default instructions layered beneath the embedded
     * PilotSwarm framework base prompt.
     */
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
    /** PostgreSQL connection string. PilotSwarm requires PostgreSQL for CMS and facts. */
    store: string;
    /**
     * Client-created sessions are always started with durable session state enabled.
     * Durability is backed by the worker's configured session store (blob or local filesystem).
     */
    waitThreshold?: number;
    dehydrateThreshold?: number;
    dehydrateOnInputRequired?: number;
    /** Seconds to keep an idle top-level session warm before dehydrating. Default: 60. */
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

    /**
     * PostgreSQL schema name for the built-in facts tables.
     * Default: `"pilotswarm_facts"`. Must match the worker's `factsSchema`.
     */
    factsSchema?: string;

    /**
     * Session creation policy. Typically set by the worker and forwarded
     * to co-located clients. Controls which sessions can be created.
     */
    sessionPolicy?: SessionPolicy;

    /**
     * Names of loaded non-system agents. Set by the worker and forwarded
     * to co-located clients for client-side policy validation.
     */
    allowedAgentNames?: string[];

    /**
     * Use AAD/Managed Identity for Postgres auth (CMS + facts) and Azure
     * Storage. When `true`, `cmsFactsDatabaseUrl` (or `store`) must be a
     * passwordless URL — the auth token is minted at connect time via
     * `DefaultAzureCredential` (see `pg-pool-factory.ts`). When `false` or
     * unset, the password embedded in `store` is used (legacy path —
     * `scripts/deploy-aks.sh` and local development). Mirrors the same
     * field on `PilotSwarmWorkerOptions`.
     */
    useManagedIdentity?: boolean;

    /**
     * Optional separate URL for CMS + facts pools. When unset, `store` is
     * reused. When `useManagedIdentity` is `true` this should be the
     * passwordless URL (e.g. `postgresql://<aad-user>@<host>/<db>?sslmode=require`).
     */
    cmsFactsDatabaseUrl?: string;

    /**
     * Override the AAD principal name used as the Postgres `user` when
     * minting tokens. Defaults to the `user` field parsed from the URL.
     * Only consulted when `useManagedIdentity` is `true`.
     */
    aadDbUser?: string;
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
    cronActive?: boolean;
    cronInterval?: number;
    cronReason?: string;
    error?: string;
    retriesExhausted?: boolean;
    contextUsage?: SessionContextUsage;
}
