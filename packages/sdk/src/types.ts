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
    | { type: "cron_at"; action: "set"; schedule: import("./cron-at.js").CronAtSchedule; events?: CapturedEvent[] }
    | { type: "cron_at"; action: "cancel"; events?: CapturedEvent[] }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] }
    | { type: "spawn_agent"; task: string; model?: string; reasoningEffort?: ReasoningEffort; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; title?: string; contract?: Record<string, unknown>; content?: string; events?: CapturedEvent[] }
    | { type: "message_agent"; agentId: string; message: string; contractPatch?: Record<string, unknown>; events?: CapturedEvent[] }
    | { type: "check_agents"; events?: CapturedEvent[] }
    | { type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] }
    | { type: "list_sessions"; includeSystem?: boolean; ownerQuery?: string; ownerKind?: string; query?: string; sessionId?: string; agentId?: string; state?: string; parentSessionId?: string; groupId?: string; includeChildren?: boolean; updatedSince?: string; summaryUpdatedSince?: string; limit?: number; events?: CapturedEvent[] }
    | { type: "complete_agent"; agentId: string; result?: Record<string, unknown>; events?: CapturedEvent[] }
    | { type: "cancel_agent"; agentId: string; reason?: string; partialResult?: Record<string, unknown>; events?: CapturedEvent[] }
    | { type: "delete_agent"; agentId: string; reason?: string; events?: CapturedEvent[] };

type QueuedTurnActionCarrier = {
    queuedActions?: TurnAction[];
};

export type TurnResult =
    | ({ type: "completed"; content: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "wait"; seconds: number; reason: string; preserveWorkerAffinity?: boolean; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron"; action: "set"; intervalSeconds: number; reason: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron"; action: "cancel"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron_at"; action: "set"; schedule: import("./cron-at.js").CronAtSchedule; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cron_at"; action: "cancel"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "spawn_agent"; task: string; model?: string; reasoningEffort?: ReasoningEffort; systemMessage?: string | { mode: "append" | "replace"; content: string }; toolNames?: string[]; agentName?: string; title?: string; contract?: Record<string, unknown>; content?: string; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "message_agent"; agentId: string; message: string; contractPatch?: Record<string, unknown>; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "check_agents"; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "wait_for_agents"; agentIds: string[]; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "list_sessions"; includeSystem?: boolean; ownerQuery?: string; ownerKind?: string; query?: string; sessionId?: string; agentId?: string; state?: string; parentSessionId?: string; groupId?: string; includeChildren?: boolean; updatedSince?: string; summaryUpdatedSince?: string; limit?: number; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "complete_agent"; agentId: string; result?: Record<string, unknown>; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
    | ({ type: "cancel_agent"; agentId: string; reason?: string; partialResult?: Record<string, unknown>; events?: CapturedEvent[] } & QueuedTurnActionCarrier)
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
            contract?: Record<string, unknown>;
        }): Promise<string>;
        messageAgent(args: { agent_id: string; message: string; contract_patch?: Record<string, unknown> }): Promise<string>;
        checkAgents(): Promise<string>;
        resolveWaitForAgents(agentIds?: string[]): Promise<string[]>;
        listSessions(args?: {
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
        }): Promise<string>;
        completeAgent(args: { agent_id: string; result?: Record<string, unknown> }): Promise<string>;
        cancelAgent(args: { agent_id: string; reason?: string; partial_result?: Record<string, unknown> }): Promise<string>;
        deleteAgent(args: { agent_id: string; reason?: string }): Promise<string>;
        updateSessionSummary(args: { summary_state: SessionSummaryState; short_summary?: string }): Promise<string>;
        sendSessionMessage(args: { session_id: string; subject: string; body: string; reason?: string; expects_response?: boolean; expires_at?: string }): Promise<string>;
        replySessionMessage(args: { request_id: string; session_id: string; body: string; verdict?: string }): Promise<string>;
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
    /** Internal: child contract supplied by the parent when this session was spawned. */
    childContract?: Record<string, unknown>;
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

export interface SessionSummaryState {
    schemaVersion: number;
    updatedAt: string;
    intent: string;
    summary: string;
    state: Record<string, unknown>;
    openQuestions: Array<Record<string, unknown>>;
    blockers: string[];
    nextActions: string[];
    domain?: Record<string, unknown>;
    links: Array<Record<string, unknown>>;
    structureChangeLog: Array<Record<string, unknown>>;
}

export interface ChildSessionContract {
    contractId?: string;
    parentSessionId: string;
    childSessionId: string;
    validationMode?: "advisory" | "strict";
    purpose?: string;
    expectedFacts?: Array<Record<string, unknown>>;
    expectedArtifacts?: Array<Record<string, unknown>>;
    successCriteria?: string[];
    blockerPolicy?: "allow-blocked-result" | "require-success";
    deadlineAt?: string;
    maxPollCount?: number;
    maxWallClockMs?: number;
    metadata?: Record<string, unknown>;
    /**
     * Autonomous parent wake policy for child updates. Defaults to
     * `"material_change"` when omitted. See child-notifications.ts.
     *
    * - `any`             - wake parent for any child update
    * - `material_change` - wake parent for material changes only
    * - `completion`      - wake parent only on terminal/blocked/error
     *
     * `wakeOn` does not affect explicit parent reads such as `check_agents`
     * or `wait_for_agents`.
     */
    wakeOn?: import("./child-notifications.js").ChildWakePolicy;
}

export type ChildSessionVerdict = "success" | "partial" | "blocked" | "failed" | "cancelled" | "timed_out";

export interface ChildSessionResult {
    sessionId: string;
    parentSessionId?: string;
    contractRevision?: number;
    verdict: ChildSessionVerdict;
    summary: string;
    factsWritten?: Array<Record<string, unknown>>;
    artifactsWritten?: Array<Record<string, unknown>>;
    blockers?: string[];
    nextActions?: string[];
    contractViolations?: Array<Record<string, unknown>>;
    completedAt: string;
    finalAssistantMessageSeq?: number;
    metadata?: Record<string, unknown>;
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
    /** "interval" for legacy cron(seconds), "wall-clock" for cron_at. v1.0.53+. */
    cronKind?: "interval" | "wall-clock";
    /** Next scheduled fire (UTC ms) for active wall-clock cron_at schedules. */
    cronNextFireAt?: number;
    /** IANA timezone for active wall-clock cron_at schedules. */
    cronTimezone?: string;
    /** Optional cap on total fires for cron_at schedules. */
    cronMaxFires?: number;
    /** Number of fires completed for cron_at schedules. */
    cronFiresCompleted?: number;
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
    /** Optional visual session group assignment. */
    groupId?: string;
    /** Short live summary for discovery/session lists. */
    shortSummary?: string;
    /** Structured live summary state. */
    summaryState?: SessionSummaryState;
    /** Last time summaryState/shortSummary was updated. */
    summaryUpdatedAt?: Date;
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
    /** Active wall-clock recurring schedule set by the cron_at tool. */
    cronAtSchedule?: import("./cron-at.js").CronAtSchedule;
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
    /** Last known child contract for autonomous parent wake policy decisions. */
    contract?: Record<string, unknown>;
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
     * `password` callback on every new physical connection. The duroxide
     * orchestration store goes through duroxide-node's native Entra path
     * (`PostgresProvider.connectWithSchemaAndEntra`, available since
     * duroxide-node 0.1.25), which resolves credentials in Rust via its
     * own chain (WorkloadIdentity → ManagedIdentity → DeveloperTools).
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
    cronKind?: "interval" | "wall-clock";
    cronNextFireAt?: number;
    cronTimezone?: string;
    cronMaxFires?: number;
    cronFiresCompleted?: number;
    error?: string;
    retriesExhausted?: boolean;
    contextUsage?: SessionContextUsage;
}

// ─── User OBO Envelope (Phase 1) ────────────────────────────────
// Plaintext shape used inside pod memory only. Carries principal claims
// plus optional user access token for downstream OBO exchanges.
// See ImplementationPlan.md Phase 1.

export interface PrincipalClaims {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
}

/**
 * Plaintext user envelope. NEVER written to durable queue or activity input.
 * Token fields are nullable to allow principal-only carriage when no
 * downstream worker scope is configured (FR-002 / SC-002 / P1 scenario 2).
 */
export interface UserEnvelope {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    accessToken: string | null;
    accessTokenExpiresAt: number | null;
}

/**
 * Wire ciphertext shape (versioned). AES-GCM ciphertext over
 * {accessToken, accessTokenExpiresAt} plus a KEK-wrapped DEK.
 * kekKid is the AKV key URL with version (or "plaintext-mode" for
 * the dev-only PlaintextEnvelopeCrypto backend; cross-mode interpretation
 * is REFUSED at decrypt time).
 */
export interface EnvelopeCipher {
    /** AES-GCM ciphertext, base64. */
    ciphertext: string;
    /** AES-GCM 12-byte nonce, base64. */
    iv: string;
    /** AES-GCM 16-byte tag, base64. */
    tag: string;
    /** KEK-wrapped 32-byte DEK, base64. */
    wrappedDek: string;
    /** AKV key URL with version, or "plaintext-mode" sentinel. */
    kekKid: string;
}

/**
 * The on-the-wire carrier travelling in queue payloads and runTurn
 * activity input. Principal claims are plaintext (not secret). Token
 * material is encrypted (or absent when no OBO scope is configured).
 *
 * Field name on the wire: envelope (NOT envelopeCipher) — reflects
 * that it carries plaintext principal + optional ciphertext.
 */
export interface UserEnvelopeCarrier {
    /** Carrier-shape version. Always 1 for Phase 1. */
    v: 1;
    principal: PrincipalClaims;
    /** Null when no OBO scope configured for the deployment. */
    accessTokenCipher: EnvelopeCipher | null;
}

/**
 * Lookup return type (Phase 2 exposes the public lookup; Phase 1 stores
 * this shape in the in-memory UserContextStore).
 */
export interface UserContext {
    principal: PrincipalClaims;
    accessToken: string | null;
    accessTokenExpiresAt: number | null;
}

// ─── Phase 4: Structured tool outcomes ───────────────────────────────
//
// Two members of the Structured tool outcome family that worker tools can
// emit (via interactionRequired() / serviceUnavailable() from
// "pilotswarm-sdk") to communicate something fundamentally different from
// generic tool failure:
//
//   * interaction_required — the user must re-authenticate at the IdP
//     before the tool can proceed. Triggers a re-auth affordance in the
//     portal. The opaque `claims` blob (IdP claims-challenge) is persisted
//     server-side but NEVER passed to the LLM.
//
//   * service_unavailable — a transport-layer dependency (AKV unwrap,
//     downstream IdP, etc.) is persistently unavailable. The user has
//     nothing to do; the UI surfaces a transient-error notice with an
//     optional retry-after countdown.
//
// Three-way distinguishability vs generic failure (SC-005) is preserved
// at the event-data level via a separate `outcome` field.

export type ToolOutcomeKind = "success" | "failure" | "interaction_required" | "service_unavailable";

export interface InteractionRequiredPayload {
    reasonCode: string;
    message?: string | null;
    /**
     * Opaque IdP claims-challenge blob. Persisted in the CMS event row so
     * the portal can forward it to MSAL's `acquireToken({ claims })`
     * call; NEVER included in the LLM-visible text result.
     */
    claims?: string | null;
}

export interface ServiceUnavailablePayload {
    reasonCode: string;
    retryAfter?: number | null;
    message?: string | null;
}

export type ToolOutcomePayload = InteractionRequiredPayload | ServiceUnavailablePayload;

/**
 * Marker field embedded in a tool handler's return value by the
 * `interactionRequired` / `serviceUnavailable` helpers. Detected by
 * ManagedSession's tool wrapper and stripped before the LLM-visible
 * string is shipped to the model.
 */
export interface ToolOutcomeMarker {
    kind: "interaction_required" | "service_unavailable";
    payload: ToolOutcomePayload;
}

export const PS_TOOL_OUTCOME_MARKER = "__pilotswarmToolOutcome" as const;

