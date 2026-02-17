import type { Tool, SessionConfig } from "@github/copilot-sdk";

// ─── Types mirroring Copilot SDK (not exported by the SDK) ──────
// These match the SDK's internal types so the API feels identical.

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

// ─── Client Options ──────────────────────────────────────────────
// Mirrors CopilotClientOptions, adds durability config.

export interface DurableCopilotClientOptions {
    // --- Copilot SDK options (same names, same semantics) ---

    /** GitHub token for Copilot API access (server-side only). */
    githubToken?: string;

    /** Path to the Copilot CLI binary (auto-detected if omitted). */
    cliPath?: string;

    /** Working directory for file operations. */
    cwd?: string;

    /** Log level for the Copilot CLI process. */
    logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";

    // --- Durability options (the new stuff) ---

    /**
     * Where to store durable state.
     * - "sqlite://./path.db" — local SQLite (dev/testing)
     * - "sqlite::memory:" — in-memory SQLite (testing)
     * - "postgres://user:pass@host:5432/db" — PostgreSQL (production)
     */
    store: string;

    /**
     * Wait threshold in seconds. Waits shorter than this sleep in-process.
     * Waits longer than this dehydrate and use a durable timer.
     * @default 60
     */
    waitThreshold?: number;

    /**
     * Maximum LLM turns per orchestration before aborting (safety guard).
     * @default 50
     */
    maxIterations?: number;
}

// ─── Session Config ──────────────────────────────────────────────
// Mirrors SessionConfig from @github/copilot-sdk, adds durable hooks.

export interface DurableSessionConfig {
    // --- Copilot SDK SessionConfig fields (same names) ---

    /** Explicit session ID. Generated if omitted. */
    sessionId?: string;

    /** Model to use (e.g., "claude-sonnet-4", "gpt-4"). */
    model?: string;

    /** Tools available to the agent. Use defineTool() to create these. */
    tools?: Tool<any>[];

    /** System message — either a string (appended) or full config. */
    systemMessage?: string | { mode: "append" | "replace"; content: string };

    /** Working directory for file operations. */
    workingDirectory?: string;

    /**
     * Called when the LLM asks for user input.
     * Same signature as Copilot SDK's onUserInputRequest.
     *
     * In durable mode this blocks the activity while waiting for the
     * answer to arrive via agent_events in Postgres.
     */
    onUserInputRequest?: UserInputHandler;

    /**
     * Hooks for tool execution lifecycle.
     * Same as Copilot SDK SessionConfig hooks.
     */
    hooks?: SessionConfig["hooks"];
}

// ─── Turn Result ─────────────────────────────────────────────────
// What the runAgentTurn activity returns to the orchestration.

/** @internal */
export type TurnResult =
    | { type: "completed"; content: string }
    | { type: "wait"; seconds: number; reason: string; content?: string }
    | { type: "input_required"; question: string; choices?: string[]; allowFreeform?: boolean }
    | { type: "error"; message: string };

// ─── Session Status / Events ─────────────────────────────────────

/** Status of a durable session — superset of SDK session lifecycle. */
export type DurableSessionStatus =
    | "pending"    // orchestration created, not yet picked up by a worker
    | "running"    // LLM turn in progress
    | "idle"       // turn complete, waiting for next send()
    | "waiting"    // durable timer (long wait)
    | "input_required"  // waiting for user input
    | "completed"  // final answer returned
    | "failed";    // unrecoverable error

/** Info about a durable session — mirrors SDK's SessionMetadata. */
export interface DurableSessionInfo {
    sessionId: string;
    status: DurableSessionStatus;
    createdAt: Date;
    updatedAt: Date;
    /** Set when status is "input_required". */
    pendingQuestion?: UserInputRequest;
    /** Set when status is "waiting". */
    waitingUntil?: Date;
    waitReason?: string;
    /** Set when status is "completed". */
    result?: string;
    /** Set when status is "failed". */
    error?: string;
    /** Number of LLM turns so far. */
    iterations: number;
}

// ─── Internal State ──────────────────────────────────────────────

/**
 * Input to the durable-turn orchestration.
 * @internal
 */
export interface TurnInput {
    sessionId: string;
    prompt: string;
    waitThreshold: number;
    maxIterations: number;
    iteration: number;
    /** System message passed through durable state for scaled/remote workers. */
    systemMessage?: string;
    /** Model override passed through durable state. */
    model?: string;
}
