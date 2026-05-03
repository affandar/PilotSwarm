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
    type: "wait" | "cron" | "idle" | "agent-poll" | "input-grace";
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
    preserveAffinityOnHydrate: boolean;
    blobEnabled: boolean;
    lastLiveSessionAction: "session-activity" | "dehydrate";
    pendingRehydrationMessage?: string;

    pendingPrompt?: string;
    pendingRequiredTool?: string;
    pendingSystemPrompt?: string;
    bootstrapPrompt: boolean;

    pendingToolActions: TurnAction[];
    subAgents: SubAgentEntry[];

    taskContext?: string;
    cronSchedule?: CronSchedule;
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

    legacyPendingMessage: unknown;

    orchestrationResult: string | null;
}

/** Immutable per-execution configuration derived from the orchestration input. */
export interface DurableSessionOptions {
    dehydrateThreshold: number;
    idleTimeout: number;
    inputGracePeriod: number;
    checkpointInterval: number;
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
        preserveAffinityOnHydrate: input.preserveAffinityOnHydrate ?? false,
        blobEnabled: input.blobEnabled ?? false,
        lastLiveSessionAction: "session-activity",
        pendingRehydrationMessage: input.rehydrationMessage,

        pendingPrompt: input.prompt,
        pendingRequiredTool: input.requiredTool,
        pendingSystemPrompt: input.systemPrompt,
        bootstrapPrompt: input.bootstrapPrompt ?? false,

        pendingToolActions: input.pendingToolActions ? [...input.pendingToolActions] : [],
        subAgents: input.subAgents ? [...input.subAgents] : [],

        taskContext: input.taskContext,
        cronSchedule: input.cronSchedule ? { ...input.cronSchedule } : undefined,
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

        legacyPendingMessage: undefined,

        orchestrationResult: null,
    };
}

export function deriveOptions(input: OrchestrationInput): DurableSessionOptions {
    return {
        dehydrateThreshold: input.dehydrateThreshold ?? 29,
        idleTimeout: input.idleTimeout ?? 60,
        inputGracePeriod: input.inputGracePeriod ?? 30,
        checkpointInterval: input.checkpointInterval ?? -1,
        isSystem: input.isSystem ?? false,
        parentSessionId: input.parentSessionId
            ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, "") : undefined),
        nestingLevel: input.nestingLevel ?? 0,
        baseSystemMessage: input.baseSystemMessage ?? input.config?.systemMessage,
    };
}
