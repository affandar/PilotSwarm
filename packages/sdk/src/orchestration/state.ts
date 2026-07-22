import { sanitizePromptAttachmentRefs } from "../types.js";
import type {
    OrchestrationInput,
    SerializableSessionConfig,
    SessionContextUsage,
    SubAgentEntry,
    TurnAction,
} from "../types.js";
import { cloneContextUsage } from "./utils.js";

export interface ActiveTimer {
    deadlineMs: number;
    originalDurationMs: number;
    reason: string;
    type: "wait" | "cron" | "cron_at" | "idle" | "agent-poll" | "input-grace";
    shouldRehydrate?: boolean;
    waitPlan?: { shouldDehydrate: boolean; resetAffinityOnDehydrate: boolean; preserveAffinityOnHydrate: boolean };
    content?: string;
    question?: string;
    choices?: string[];
    allowFreeform?: boolean;
    agentIds?: string[];
}

export type ShutdownMode = NonNullable<OrchestrationInput["pendingShutdown"]>["mode"];
export type PendingShutdownState = NonNullable<OrchestrationInput["pendingShutdown"]>;
export type PendingChildDigest = NonNullable<OrchestrationInput["pendingChildDigest"]>;
export type PendingInputQuestion = NonNullable<OrchestrationInput["pendingInputQuestion"]>;
export type CronSchedule = NonNullable<OrchestrationInput["cronSchedule"]>;
export type CronAtSchedule = NonNullable<OrchestrationInput["cronAtSchedule"]>;

export interface InterruptedWaitTimer {
    remainingSec: number;
    reason: string;
    shouldRehydrate: boolean;
    waitPlan?: ActiveTimer["waitPlan"];
    interruptKind?: "child" | "user";
}

export interface InterruptedCronTimer {
    remainingMs: number;
    reason: string;
    originalDurationMs?: number;
    shouldRehydrate?: boolean;
}

/** Mutable orchestration state — replaces the closure of `let`s in the prior monolith. */
export interface DurableSessionState {
    config: SerializableSessionConfig;
    affinityKey: string;

    iteration: number;
    loopIteration: number;
    retryCount: number;

    needsHydration: boolean;
    /**
     * Session lifecycle protocol: last committed snapshot-store version,
     * recorded from each runTurn result. 0 = no commit recorded yet.
     * Threaded through continue-as-new; the next turn's activity input
     * carries it as `snapshot.expectedVersion` for worker self-validation.
     */
    snapshotVersion: number;
    preserveAffinityOnHydrate: boolean;
    blobEnabled: boolean;
    pendingRehydrationMessage?: string;

    pendingPrompt?: string;
    /** Attachment refs for the carried pendingPrompt — dropped silently before 1.0.65's carry fix. */
    pendingAttachments?: import("../types.js").PromptAttachmentRef[];
    pendingRequiredTool?: string;
    pendingSystemPrompt?: string;
    runtimeModelNotice?: string;
    blockedError?: { message: string; authFailure?: boolean };
    pendingCycleOrigin?: "cron" | "cron_at";
    bootstrapPrompt: boolean;

    pendingToolActions: TurnAction[];
    subAgents: SubAgentEntry[];
    /** Child-side: first completion report already sent to the parent. */
    reportedFirstCompletionToParent: boolean;

    taskContext?: string;
    cronSchedule?: CronSchedule;
    cronAtSchedule?: CronAtSchedule;
    nextSummarizeAt: number;

    contextUsage?: SessionContextUsage;

    activeTimer: ActiveTimer | null;
    pendingInputQuestion: PendingInputQuestion | null;
    waitingForAgentIds: string[] | null;
    interruptedWaitTimer: InterruptedWaitTimer | null;
    interruptedCronTimer: InterruptedCronTimer | null;
    pendingChildDigest: PendingChildDigest | null;
    pendingShutdown: PendingShutdownState | null;

    lastResponseVersion: number;
    lastCommandVersion: number;
    lastCommandId?: string;

    cancelledMessageIds: Set<string>;
    emittedCancelledMessageIds: Set<string>;
    recentClientMessageIds: string[];

    legacyPendingMessage: unknown;

    orchestrationResult: string | null;

    // ── Multi-writer attribution (security model) ────────────────
    // Distinct sender identity keys observed on sender-carrying messages.
    // Only populated when payloads carry the (optional) sender field, so
    // pre-sender histories replay identically.
    observedSenderKeys: string[];
    /** True once a non-owner sender (or a second distinct sender) appears. */
    multiWriter: boolean;
    /** Whether the [SHARED SESSION] preamble has been issued to the agent. */
    sharedPreambleSent: boolean;
    /** Owner display name learned from an owner-relation sender. */
    ownerDisplay?: string;
}

/** Immutable per-execution configuration derived from the orchestration input. */
export interface DurableSessionOptions {
    idleTimeout: number;
    inputGracePeriod: number;
    isSystem: boolean;
    parentSessionId?: string;
    nestingLevel: number;
    baseSystemMessage?: string | { mode: "append" | "replace"; content: string };
}

/** Single object passed through every orchestration helper. */
export interface DurableSessionRuntime {
    ctx: any;
    input: OrchestrationInput;
    versions: { currentVersion: string; latestVersion: string };
    manager: any;
    /** Mutable: reassigned when affinity rotates on hydrate/dehydrate. */
    session: any;
    state: DurableSessionState;
    options: DurableSessionOptions;
}

// ─── Constants ──────────────────────────────────────────────

export const INTERNAL_SYSTEM_TURN_PROMPT =
    "Internal orchestration wake-up. The user did not send a new message. Continue with the latest system instructions.";

export const MAX_RETRIES = 3;
export const MAX_SUB_AGENTS = 50;
export const MAX_NESTING_LEVEL = 2;
export const CHILD_UPDATE_BATCH_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 60_000;
export const SHUTDOWN_POLL_INTERVAL_MS = 5_000;

export const FIRST_SUMMARIZE_DELAY = 60_000;
export const REPEAT_SUMMARIZE_DELAY = 300_000;

export const FIFO_BUCKET_COUNT = 20;
export const MAX_BUCKET_BYTES = 14 * 1024;
export const MAX_DRAIN_PER_TURN = 50;
export const MAX_PREDISPATCH_SWEEP = 50;
export const MAX_ITERATIONS_PER_EXECUTION = 10;
export const MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES = 800 * 1024;
export const HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS = 3;
export const NON_BLOCKING_TIMER_MS = 10;
export const PREDISPATCH_CANCEL_SWEEP_MS = 100;
export const RECENT_CLIENT_MESSAGE_ID_LIMIT = 20;

// ─── Initial state construction ─────────────────────────────

function clonePendingChildDigest(input: OrchestrationInput["pendingChildDigest"]): PendingChildDigest | null {
    if (!input) return null;
    return {
        startedAtMs: input.startedAtMs,
        ...(input.ready ? { ready: true } : {}),
        updates: [...(input.updates || [])],
    };
}

function clonePendingShutdown(input: OrchestrationInput["pendingShutdown"]): PendingShutdownState | null {
    if (!input) return null;
    return {
        ...input,
        targetAgentIds: [...(input.targetAgentIds || [])],
    };
}

export function normalizeRecentClientMessageIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const raw of value) {
        if (typeof raw !== "string" || !raw || ids.includes(raw)) continue;
        ids.push(raw);
    }
    return ids.slice(-RECENT_CLIENT_MESSAGE_ID_LIMIT);
}

export function touchRecentClientMessageIds(state: DurableSessionState, ids: string[]): void {
    const validIds = ids.filter((id, index) => Boolean(id) && ids.indexOf(id) === index);
    if (validIds.length === 0) return;
    const touched = new Set(validIds);
    state.recentClientMessageIds = state.recentClientMessageIds.filter((id) => !touched.has(id));
    state.recentClientMessageIds.push(...validIds);
    state.recentClientMessageIds = state.recentClientMessageIds.slice(-RECENT_CLIENT_MESSAGE_ID_LIMIT);
}

export function createInitialState(input: OrchestrationInput, options: DurableSessionOptions): DurableSessionState {
    const config = { ...input.config };
    if (input.taskContext) {
        const base = typeof options.baseSystemMessage === "string"
            ? options.baseSystemMessage ?? ""
            : (options.baseSystemMessage as any)?.content ?? "";
        config.systemMessage = base + (base ? "\n\n" : "") +
            "[RECURRING TASK]\n" +
            "Original user request (always remember, even if conversation history is truncated):\n\"" +
            input.taskContext + "\"";
    }
    if (input.agentId) {
        config.agentIdentity = input.agentId;
    }

    return {
        config,
        affinityKey: input.affinityKey ?? input.sessionId,

        iteration: input.iteration ?? 0,
        loopIteration: 0,
        retryCount: input.retryCount ?? 0,

        needsHydration: input.needsHydration ?? false,
        snapshotVersion: input.snapshotVersion ?? 0,
        preserveAffinityOnHydrate: input.preserveAffinityOnHydrate ?? false,
        blobEnabled: input.blobEnabled ?? false,
        pendingRehydrationMessage: input.rehydrationMessage,

        pendingPrompt: input.prompt,
        pendingAttachments: sanitizePromptAttachmentRefs(input.attachments),
        pendingRequiredTool: input.requiredTool,
        pendingSystemPrompt: input.systemPrompt,
        runtimeModelNotice: input.runtimeModelNotice,
        blockedError: input.blockedError ? { ...input.blockedError } : undefined,
        pendingCycleOrigin: input.cycleOrigin,
        bootstrapPrompt: input.bootstrapPrompt ?? false,

        pendingToolActions: input.pendingToolActions ? [...input.pendingToolActions] : [],
        subAgents: input.subAgents ? [...input.subAgents] : [],
        reportedFirstCompletionToParent: Boolean(input.reportedFirstCompletionToParent),

        taskContext: input.taskContext,
        cronSchedule: input.cronSchedule ? { ...input.cronSchedule } : undefined,
        cronAtSchedule: input.cronAtSchedule ? { ...input.cronAtSchedule } : undefined,
        nextSummarizeAt: input.nextSummarizeAt ?? 0,

        contextUsage: cloneContextUsage(input.contextUsage),

        activeTimer: null,
        pendingInputQuestion: input.pendingInputQuestion ?? null,
        waitingForAgentIds: input.waitingForAgentIds ?? null,
        interruptedWaitTimer: input.interruptedWaitTimer ?? null,
        interruptedCronTimer: input.interruptedCronTimer ?? null,
        pendingChildDigest: clonePendingChildDigest(input.pendingChildDigest),
        pendingShutdown: clonePendingShutdown(input.pendingShutdown),

        lastResponseVersion: 0,
        lastCommandVersion: 0,
        lastCommandId: undefined,

        cancelledMessageIds: new Set<string>(),
        emittedCancelledMessageIds: new Set<string>(),
        recentClientMessageIds: normalizeRecentClientMessageIds(input.recentClientMessageIds),

        legacyPendingMessage: undefined,

        orchestrationResult: null,

        // Multi-writer attribution: carried across continue-as-new so a
        // shared session keeps its attribution posture (fields absent on
        // legacy CAN inputs normalize to single-writer defaults).
        observedSenderKeys: Array.isArray((input as any).observedSenderKeys) ? [...(input as any).observedSenderKeys] : [],
        multiWriter: (input as any).multiWriter === true,
        sharedPreambleSent: (input as any).sharedPreambleSent === true,
        ownerDisplay: typeof (input as any).ownerDisplay === "string" ? (input as any).ownerDisplay : undefined,
    };
}

export function deriveOptions(input: OrchestrationInput): DurableSessionOptions {
    return {
        // Lifecycle protocol: the idle timer is the affinity HOLD WINDOW —
        // its fire releases the worker (GUID rotation), it no longer
        // dehydrates. 30 minutes, not 60 seconds. Legacy executions CAN in
        // with an explicit 60 (the old system default, threaded through
        // every historical CAN input) — treat that sentinel as unset so
        // migrated sessions actually get the hold window.
        // (dehydrateThreshold / checkpointInterval inputs are accepted but
        // meaningless here: turns commit inside the runTurn activity and
        // waits never dehydrate — the fields live on only for ≤1.0.56.)
        idleTimeout: input.idleTimeout == null || input.idleTimeout === 60
            ? 1_800
            : input.idleTimeout,
        inputGracePeriod: input.inputGracePeriod ?? 30,
        isSystem: input.isSystem ?? false,
        parentSessionId: input.parentSessionId
            ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, "") : undefined),
        nestingLevel: input.nestingLevel ?? 0,
        baseSystemMessage: input.baseSystemMessage ?? input.config?.systemMessage,
    };
}
