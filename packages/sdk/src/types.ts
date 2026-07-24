import type { Tool, SessionConfig } from "@github/copilot-sdk";
import type { SessionStateStore } from "./session-store.js";
import type { ReasoningEffort } from "./model-providers.js";
import type { EmbeddingEndpointConfig } from "./facts-store.js";
import type { StorageConfig } from "./storage-config.js";

export const SESSION_STATE_MISSING_PREFIX = "SESSION_STATE_MISSING:";

// ─── Turn Result ─────────────────────────────────────────────────
// What ManagedSession.runTurn() returns to the orchestration.

export type CycleReportStatus = "quiet" | "material" | "blocked";

export interface CycleReport {
    status: CycleReportStatus;
    summary?: string;
    deltas?: string[];
}

export type TurnAction =
    | { type: "completed"; content: string; forceContinuePrompt?: string; events?: CapturedEvent[] }
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

/**
 * Session lifecycle protocol (1.0.57+): the runTurn activity commits the
 * post-turn snapshot inside the activity and reports the new store version
 * on its result. Older orchestration versions ignore the field.
 */
type SnapshotCommitCarrier = {
    snapshotVersion?: number;
};

export type TurnResult = TurnResultVariant & SnapshotCommitCarrier;

type TurnResultVariant =
    | ({ type: "completed"; content: string; forceContinuePrompt?: string; events?: CapturedEvent[]; cycleReport?: CycleReport } & QueuedTurnActionCarrier)
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
    | { type: "stopped"; reason?: string; events?: CapturedEvent[] }
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
    /** Orchestration turn index for this turn — used by stop-turn targeting. */
    turnIndex?: number;
    /** Model summary text for the list_available_models tool. */
    modelSummary?: string;
    /** Internal: startup/bootstrap turn that should not be recorded as a user message. */
    bootstrap?: boolean;
    /** Require the Copilot SDK to use a specific tool during this turn. */
    requiredTool?: string;
    /** Internal: this turn was started by a recurring cron/cron_at timer fire. */
    cycleOrigin?: "cron" | "cron_at";
    /**
     * Ready-to-send image blobs for this turn, resolved from artifact refs by
     * the runTurn activity host (bytes fetched + vision-gated there). Passed
     * straight through to the Copilot session as blob attachments.
     */
    attachments?: Array<{ data: string; mimeType: string; displayName?: string }>;
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
        setSessionModel(args: { model: string; reasoning_effort?: ReasoningEffort | null }): Promise<string>;
        /** Session regeneration: enqueue the durable regenerate cmd for THIS session (sender-stamped server-side). */
        regenerateContext?(args: { handoff?: string }): Promise<string>;
        /** Session regeneration: enqueue the durable regenerate cmd for a DIRECT child (requestedBy-stamped). */
        regenerateAgent?(args: { agent_id: string; handoff?: string }): Promise<string>;
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
        updateSessionSummary(args: { summary_state?: SessionSummaryState; short_summary?: string; title?: string }): Promise<string>;
        sendSessionMessage(args: { session_id: string; subject: string; body: string; reason?: string; expects_response?: boolean; expires_at?: string }): Promise<string>;
        replySessionMessage(args: { request_id: string; session_id: string; body: string; verdict?: string }): Promise<string>;
    };
}

// ─── Session Config ──────────────────────────────────────────────

/** Serializable config — travels through duroxide (no functions). */
export interface SerializableSessionConfig {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    /** Context-window tier ("default" = smaller window; "long_context" = the model's long-context tier). */
    contextTier?: import("./model-providers.js").ContextTier;
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
    /**
     * Internal: when `true`, this session holds the app-assigned CRAWLER role
     * and receives privileged crawl-queue tools when a graph store is
     * configured. The role is derived from the bound agent's `crawler: true`
     * frontmatter (or legacy `harvester: true` alias), never trusted from user
     * input.
     */
    isCrawler?: boolean;
    /** @deprecated Use `isCrawler`; accepted as a compatibility alias. */
    isHarvester?: boolean;
}

/** Full config — includes non-serializable fields (tools, hooks). Stays in memory. */
export interface ManagedSessionConfig extends SerializableSessionConfig {
    tools?: Tool<any>[];
    hooks?: SessionConfig["hooks"];
    /**
    * Wall-clock cap on a single turn, in milliseconds. 0 = no cap;
    * undefined = the worker deployment setting or 20-minute SDK default.
     */
    turnTimeoutMs?: number;
    /**
     * Inactivity watchdog, in milliseconds: settle the turn as a retryable
     * transport-loss error when the Copilot CLI subprocess emits no events
     * for this long. A dead subprocess never fires session.idle, so without
     * this a mid-turn crash leaves the durable runTurn activity in-flight
     * forever (zombie turn). 0 = disabled; undefined =
     * DEFAULT_TURN_INACTIVITY_TIMEOUT_MS (5 minutes).
     */
    turnInactivityTimeoutMs?: number;
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
    /** Narrow-viewport splash variant, used when the main splash art is wider than the pane. */
    splashMobile?: string;
    /**
     * The viewer's private group placement for this session's tree root.
     * Placement is viewer-scoped, so this is only populated when the listing
     * carries a placement viewer (worker-side listings have none).
     */
    viewerGroupId?: string;
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

/** Regeneration pipeline state (session regen, orch 1.0.67+). */
export interface RegenState {
    /** Lifecycle command id — scopes every storage object the attempt produces. */
    attemptId: string;
    stage: "requested" | "archived" | "distilled" | "flipping";
    requestedAtMs: number;
    trigger: "operator" | "tool" | "parent" | "policy";
    /** Server-stamped requester (sender key for tool, parent session id for parent). */
    requestedBy?: string;
    /** Quoted, length-capped handoff text (untrusted distiller input). */
    handoff?: string;
    distillerModel?: string;
    /** Optional replacement model applied to the reborn session at the flip. */
    model?: string;
    archiveArtifactId?: string;
    packageArtifactId?: string;
    /** Rendered bootstrap prompt produced by the distill stage. */
    bootstrap?: string;
}

/** Post-flip boundary record carried through the regenerate continue-as-new. */
export interface PendingEpochCommit {
    fromEpoch: number;
    toEpoch: number;
    attemptId: string;
    trigger: string;
    /** ms when the attempt was accepted — feeds last_regen_stats.totalMs. */
    requestedAtMs?: number;
    archiveArtifactId?: string;
    packageArtifactId?: string;
    turnsArchived?: number;
    compactionsArchived?: number;
    archiveMs?: number;
    distillMs?: number;
}

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
    /** Transcript epoch (session regeneration, 1.0.67+). 0/absent = original SDK session. */
    transcriptEpoch?: number;
    /** One-shot: the next turn is the first of a fresh epoch (dispatches as runTurn2). */
    epochStartPending?: boolean;
    /** In-flight regeneration pipeline state, carried across non-flip CANs. */
    regen?: RegenState;
    /** Post-flip boundary record; consumed by the new execution's first drain. */
    pendingEpochCommit?: PendingEpochCommit;
    /** state.iteration at the current epoch's start — min-age gate baseline. */
    epochStartIteration?: number;
    /** Epoch-ms of the last completed flip — the agent-initiated cooldown baseline. */
    lastRegenAtMs?: number;
    responseVersion?: number;
    commandVersion?: number;
    affinityKey?: string;
    /** Internal: preserve the current worker affinity across the next hydration attempt. */
    preserveAffinityOnHydrate?: boolean;
    needsHydration?: boolean;
    blobEnabled?: boolean;
    prompt?: string;
    /** Image attachment refs riding a carried prompt across continue-as-new (1.0.65+). */
    attachments?: PromptAttachmentRef[];
    /** Internal: require the next prompt turn to use a specific tool if available. */
    requiredTool?: string;
    /** Internal: system guidance carried alongside the next prompt without becoming user text. */
    systemPrompt?: string;
    /** Internal: one-shot current-model guidance attached to the next real prompt after a model switch. */
    runtimeModelNotice?: string;
    /** Internal: non-retryable turn error kept visible until the next user prompt. */
    blockedError?: { message: string; authFailure?: boolean };
    /** Internal: pending prompt is a bootstrap message, not a user-authored prompt. */
    bootstrapPrompt?: boolean;
    /** Internal: the pending prompt was produced by a recurring cron/cron_at timer fire. */
    cycleOrigin?: "cron" | "cron_at";
    // Thresholds
    /** Seconds above which wait/cron timers proactively dehydrate. Default: 29. */
    dehydrateThreshold?: number;
    idleTimeout?: number;
    inputGracePeriod?: number;
    /**
     * Session lifecycle protocol (1.0.57+): last committed snapshot-store
     * version, recorded from each runTurn result and threaded through
     * continue-as-new. 0 = no commit recorded yet.
     */
    snapshotVersion?: number;
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
    /** Most recently accepted client message ids, oldest to newest (max 20). */
    recentClientMessageIds?: string[];

    // ─── Multi-writer attribution (security model) ───────────
    /** Distinct sender identity keys observed on sender-carrying messages. */
    observedSenderKeys?: string[];
    /** True once a non-owner sender (or a second distinct sender) appeared. */
    multiWriter?: boolean;
    /** Whether the [SHARED SESSION] preamble has been issued to the agent. */
    sharedPreambleSent?: boolean;
    /** Owner display name learned from an owner-relation sender. */
    ownerDisplay?: string;

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
            cycleOrigin?: "cron" | "cron_at";
            cycleStatus?: CycleReportStatus;
            verdict?: ChildSessionVerdict;
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
    /**
     * Child-side flag: this session has already delivered its first
     * completion report to its parent. The first final answer of a spawned
     * child always notifies the parent regardless of the wake policy — a
     * task child that finishes silently strands the parent (observed live:
     * a 72-minute hole ended only by a human poke). Carried across
     * continueAsNew.
     */
    reportedFirstCompletionToParent?: boolean;
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
    status: "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle" | "input_required";
    /** Final result content (set when status becomes completed). */
    result?: string;
    /**
     * True from spawn until the child's first substantive report reaches the
     * parent (completion update, failure, or observed quiescence). Lets the
     * orchestration surface "all children went quiet while a report was still
     * expected" instead of waiting for a human to poke.
     */
    expectsReport?: boolean;
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
        /** Preferred named agent for app UIs; hosts may use it as a picker/default selection hint. */
        defaultAgent?: string;
        /** PilotSwarm-bundled optional named agents to make available in this app. */
        bundledAgents?: string[];
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
    /**
     * Duroxide work-item lock timeout (ms). Governs how fast a crashed
     * worker's in-flight activities are re-dispatched elsewhere. Default
     * 10 000; fault-injection tests shrink it so kill/recovery cycles run
     * in seconds. (The duroxide SESSION lock timeout — ~30s — is not
     * exposed and remains the reclaim floor for session-pinned work.)
     */
    workerLockTimeoutMs?: number;
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
     * Wall-clock cap on a single LLM turn, in milliseconds. If a turn takes
     * longer than this it is aborted and settled as a retryable error.
    * 0 = no cap; undefined = PILOTSWARM_TURN_TIMEOUT_MS or the 20-minute default.
     */
    turnTimeoutMs?: number;

    /**
     * Inactivity watchdog for a single LLM turn, in milliseconds. If the
     * Copilot CLI subprocess emits no events for this long mid-turn, the turn
     * is settled as a retryable transport-loss error instead of hanging
     * forever on a dead subprocess. 0 = disabled; undefined = 5-minute default.
     */
    turnInactivityTimeoutMs?: number;

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
     * Resolved storage config. When supplied, this is the source of truth for
     * runtime storage and duroxide storage; legacy flat storage fields are used
     * only as compatibility inputs when this is omitted.
     */
    storageConfig?: StorageConfig;

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
    * Default: `"ps_duroxide"`. Change this to run multiple independent
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

    // ─── EnhancedFactStore + GraphStore (optional, enhancedfactstore 07 P3) ──

    /**
     * Connection URL for an EnhancedFactStore provider (multi-signal search +
     * durable embedder), e.g. a HorizonDB cluster with pgvector/pg_textsearch/
     * pg_durable. When set (or `factsProvider: "horizon"`), the worker constructs
     * the enhanced provider instead of the default `PgFactStore`.
     * Resolution: `enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store`.
     * Unset ⇒ today's behaviour (plain `PgFactStore`).
     */
    enhancedFactsDatabaseUrl?: string;
    /**
     * Explicit facts-store provider selector. Default inferred: `"horizon"` iff
     * `enhancedFactsDatabaseUrl` is set, else `"pg"`. Selecting `"horizon"`
    * dynamically imports `pilotswarm-horizon-store`; a missing package is a
     * clear startup error only when horizon is explicitly selected.
     */
    factsProvider?: "pg" | "horizon";
    /**
     * Schema for the enhanced facts store. Default: `"horizon_facts"`.
     */
    enhancedFactsSchema?: string;
    /**
     * Embedding endpoint for the enhanced provider's durable in-DB embedder.
     * Sourced from env (`HORIZON_EMBED_*`). When omitted, semantic search returns
     * nothing for un-embedded facts (lexical still works).
     */
    horizonEmbed?: EmbeddingEndpointConfig;

    /**
     * OPT-IN graph store target (Apache AGE). When set, the worker constructs a
     * separate `GraphStore` provider (`HorizonDBGraphStore`) and graph tools light
     * up (`!!graphStore`). May be the SAME URL as `enhancedFactsDatabaseUrl` (one
     * HorizonDB) or a distinct database. Unset ⇒ no graph store, no graph tools —
     * never selected implicitly.
     */
    graphDatabaseUrl?: string;
    /**
     * Schema/graph name for the graph store. Default: `"horizon_graph"`.
     * Apache AGE creates a Postgres schema named after the graph, so on a shared
     * database this MUST differ from the facts schema — the worker fails fast if
     * `graphSchema` collides with the facts schema on the same `graphDatabaseUrl`.
     */
    graphSchema?: string;
    /**
     * Graph-owned relational schema for namespace registry discovery metadata.
     * Default (provider): `${graphSchema}_registry`. Must differ from
     * `graphSchema`, because Apache AGE owns a Postgres schema named after the
     * graph. Env: `HORIZON_GRAPH_REGISTRY_SCHEMA`.
     */
    graphRegistrySchema?: string;
    /**
     * TTL (ms) for graph namespace list caching inside the graph provider.
     * Default 60000; set 0 to disable caching. Env:
     * `HORIZON_NAMESPACE_CACHE_TTL_MS`.
     */
    graphNamespaceCacheTtlMs?: number;

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
     * The worker reads these at startup. Skills and agents pass through
     * the SDK's `skillDirectories` / `customAgents` session config fields.
     * `.mcp.json` servers form the deployment MCP CATALOG: a session
     * receives a server only via its bound agent's `mcpServers:` /
     * `inheritDefaultMcpServers:` frontmatter (or a base-agent opt-in) —
     * the catalog is never applied to every session wholesale.
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
        skills?: string[];
    }>;

    /**
     * Additional MCP server configs (beyond plugins). These keep their
     * legacy every-session semantics: they join the deployment catalog AND
     * are applied to every session. Prefer plugin `.mcp.json` entries with
     * per-agent frontmatter declarations (or the `"default": true` tag) for
     * scoped grants.
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

/**
 * Direct-mode client options (`{ store }`): the client connects straight to
 * the datastore. This mode is for trusted server-side embedding (the portal
 * host, workers) and internal testing. Applications and remote callers use
 * web mode instead — `new PilotSwarmClient({ apiUrl })` — which requires no
 * database or storage credentials (see `PilotSwarmWebOptions`).
 */
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

    /**
     * Resolved storage config. Must match the worker. When supplied, this is
     * the source of truth for CMS/facts and duroxide storage.
     */
    storageConfig?: StorageConfig;

    /** Seconds between periodic checkpoints (blob upload without losing session pin). -1 = disabled. */
    checkpointInterval?: number;

    /** Custom message prepended to the user prompt on rehydration (after worker death). */
    rehydrationMessage?: string;

    /**
     * PostgreSQL schema name for duroxide orchestration tables.
    * Default: `"ps_duroxide"`. Must match the worker's `duroxideSchema`.
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
     * EnhancedFactStore connection URL (enhancedfactstore 07 P3). Must match the
     * worker's `enhancedFactsDatabaseUrl` so the client's facts cleanup targets
     * the same store. Unset ⇒ facts live on `cmsFactsDatabaseUrl ?? store`.
     */
    enhancedFactsDatabaseUrl?: string;
    /** Facts provider selector — must match the worker. Inferred from
     * `enhancedFactsDatabaseUrl` when omitted. */
    factsProvider?: "pg" | "horizon";
    /** Enhanced facts schema — must match the worker's `enhancedFactsSchema`. */
    enhancedFactsSchema?: string;

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
    /**
     * Server-stamped sender identity (session regeneration owner-gate).
     * Stamped by the worker-side control bridge from the runTurn activity
     * input's authoritative sender — NEVER an LLM- or client-supplied value.
     */
    sender?: Record<string, unknown>;
    /** Parent-initiated commands: the requesting parent's session id. */
    requestedBy?: string;
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

// ─── Stop Turn ───────────────────────────────────────────────────

/**
 * Turn-scoped stop queue name. The session orchestration races the in-flight
 * `runTurn` activity against a dequeue on this queue; scoping the queue name
 * to the turn index makes stale stop events structurally unable to kill a
 * later turn (a race loser is dropped and cannot be un-dropped).
 */
export function stopTurnQueueName(turnIndex: number): string {
    return `stopTurn.${turnIndex}`;
}

/** Payload enqueued on the turn-scoped stop queue by stopSessionTurn(). */
export interface StopTurnEventPayload {
    /** Command id used for the KV command-response channel. */
    id: string;
    reason?: string;
    requestedAt?: number;
}

/** Result of the worker-local abortTurn activity. */
export interface AbortTurnResult {
    outcome: "stopped" | "stop_forced" | "no_active_turn";
    turnIndex?: number;
    detail?: string;
}

/** Client-facing result of stopSessionTurn(). */
export interface StopTurnResult {
    outcome: "stopped" | "stop_forced" | "no_active_turn" | "timeout";
    turnIndex?: number;
    detail?: string;
}

export interface SessionResponsePayload {
    schemaVersion: 1;
    version: number;
    iteration: number;
    type: "completed" | "wait" | "input_required" | "error";
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

// ─── Image prompt attachments (docs/proposals/image-attachments-in-chat.md) ──

/**
 * What clients pass to sendMessage/send: a reference to an image artifact
 * already uploaded to THIS session. Everything else (content type, size) is
 * resolved server-side from artifact metadata — client declarations are not
 * trusted.
 */
export interface SendAttachmentInput {
    filename: string;
}

/**
 * The server-resolved attachment reference that rides the durable messages
 * queue and the user.message session event. Bytes never travel here — the
 * runTurn activity fetches them from the artifact store at turn time.
 */
export interface PromptAttachmentRef {
    filename: string;
    contentType: string;
    sizeBytes: number;
}

/** Raster types a model can be shown. SVG (script surface) is deliberately absent. */
export const IMAGE_ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

/** Per-attachment decoded-bytes cap — below typical provider vision budgets. */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
/** Max image attachments per message/turn. */
export const ATTACHMENTS_MAX_COUNT = 4;
/** Total decoded-bytes cap across one message/turn. */
export const ATTACHMENTS_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Normalize an untrusted attachments array (queue payloads, API bodies) into
 * well-formed refs. Drops malformed entries rather than throwing — payload
 * hygiene for replayed histories; hard validation happens at the API edge.
 */
export function sanitizePromptAttachmentRefs(raw: unknown): PromptAttachmentRef[] {
    if (!Array.isArray(raw)) return [];
    const out: PromptAttachmentRef[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const filename = typeof (entry as any).filename === "string" ? (entry as any).filename.trim() : "";
        const contentType = typeof (entry as any).contentType === "string" ? (entry as any).contentType.trim().toLowerCase() : "";
        const sizeBytes = Number((entry as any).sizeBytes);
        if (!filename || !contentType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) continue;
        out.push({ filename, contentType, sizeBytes });
        if (out.length >= ATTACHMENTS_MAX_COUNT) break;
    }
    return out;
}
