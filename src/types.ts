import type { Tool, SessionConfig } from "@github/copilot-sdk";

// ─── Turn Result ─────────────────────────────────────────────────
// What ManagedSession.runTurn() returns to the orchestration.

export type TurnResult =
    | { type: "completed"; content: string; events?: CapturedEvent[] }
    | { type: "wait"; seconds: number; reason: string; content?: string; events?: CapturedEvent[] }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean; events?: CapturedEvent[] }
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
