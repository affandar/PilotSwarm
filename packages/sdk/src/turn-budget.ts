/**
 * Turn-level prompt budget guardrails.
 *
 * Measures prompt character length before each LLM turn and applies:
 *   Soft budget — emit trace warning; prompt passes through unchanged.
 *   Hard budget — truncate prompt to hard limit; compact notice appended.
 *
 * Character proxy: ~4 chars ≈ 1 token for English text (conservative).
 * Default soft: 40 000 chars ≈ 10 K tokens.
 * Default hard: 80 000 chars ≈ 20 K tokens.
 *
 * Env vars (all optional; set to 0 to disable the respective check):
 *   TURN_SOFT_BUDGET_CHARS  (default: 40000)
 *   TURN_HARD_BUDGET_CHARS  (default: 80000)
 *   TURN_TOOL_OUTPUT_HARD_BUDGET_CHARS (default: 12000)
 *   TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS (default: 24000)
 *   TOOL_TIMEOUT_MS (default: 30000)
 *   TURN_MAX_CONCURRENT_TOOLS (default: 3)
 *   TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS (default: 8192)
 *
 * System sessions (promptLayering.kind === "pilotswarm-system-agent") are
 * excluded from budget checks by the caller in session-proxy.ts.
 */

const DEFAULT_SOFT_BUDGET_CHARS = 40_000;
const DEFAULT_HARD_BUDGET_CHARS = 80_000;
const DEFAULT_TOOL_OUTPUT_HARD_BUDGET_CHARS = 12_000;
const DEFAULT_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS = 24_000;

/** Default per-tool hard timeout in milliseconds. */
export const TOOL_TIMEOUT_MS_DEFAULT = 30_000;
/** Default max parallel tool handlers per turn. */
export const TURN_MAX_CONCURRENT_TOOLS_DEFAULT = 3;
/** Default char threshold above which tool output is auto-offloaded to artifact store. */
export const TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS = 8_192;

// Appended when a prompt is hard-truncated.
const HARD_TRUNCATION_NOTICE =
    "\n\n[Prompt truncated: turn hard budget exceeded. Respond with available context only.]";
const TOOL_OUTPUT_TRUNCATION_NOTICE =
    "\n\n[Tool output truncated: payload exceeded turn tool-output budget.]";
const ASSISTANT_OUTPUT_TRUNCATION_NOTICE =
    "\n\n[Response truncated: assistant output exceeded turn output budget.]";

// Module-level counter — incremented on every soft or hard hit.
let _throttledTurns = 0;

// ─── Public types ────────────────────────────────────────────────

export type TurnBudgetDecision = "ok" | "soft" | "hard";

export interface TurnBudgetConfig {
    /** Character limit for soft warning. 0 disables the check. */
    softBudgetChars: number;
    /** Character limit for hard truncation. 0 disables the check. */
    hardBudgetChars: number;
    /** Character limit for individual tool payloads injected into model context. */
    toolOutputHardBudgetChars: number;
    /** Character limit for final assistant content returned for a turn. */
    assistantOutputHardBudgetChars: number;
    /** Hard timeout per tool handler in milliseconds. */
    toolTimeoutMs: number;
    /** Max parallel tool handlers allowed within a single turn. */
    maxConcurrentTools: number;
    /** Tool outputs larger than this are auto-offloaded to the artifact store (fire-and-forget). */
    toolArtifactOffloadThresholdChars: number;
    /** Per-tool character budget overrides by tool name. Falls back to toolOutputHardBudgetChars. */
    toolOutputBudgetByName?: Record<string, number>;
}

export interface TurnBudgetResult {
    decision: TurnBudgetDecision;
    originalChars: number;
    effectiveChars: number;
    /** The (possibly truncated) prompt text. */
    text: string;
}

export interface BudgetedOutputResult {
    originalChars: number;
    effectiveChars: number;
    trimmed: boolean;
    text: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function resolveEnvBudget(
    varName: string,
    defaultVal: number,
    env: Record<string, string | undefined>,
): number {
    const raw = env[varName];
    if (!raw) return defaultVal;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return defaultVal;
    return parsed;
}

// ─── Public API ─────────────────────────────────────────────────

/** Reads budget/control env vars and returns a fully-populated TurnBudgetConfig. */
export function buildTurnBudgetConfig(
    env: Record<string, string | undefined> = process.env,
): TurnBudgetConfig {
    return {
        softBudgetChars: resolveEnvBudget("TURN_SOFT_BUDGET_CHARS", DEFAULT_SOFT_BUDGET_CHARS, env),
        hardBudgetChars: resolveEnvBudget("TURN_HARD_BUDGET_CHARS", DEFAULT_HARD_BUDGET_CHARS, env),
        toolOutputHardBudgetChars: resolveEnvBudget(
            "TURN_TOOL_OUTPUT_HARD_BUDGET_CHARS",
            DEFAULT_TOOL_OUTPUT_HARD_BUDGET_CHARS,
            env,
        ),
        assistantOutputHardBudgetChars: resolveEnvBudget(
            "TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS",
            DEFAULT_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS,
            env,
        ),
        toolTimeoutMs: resolveEnvBudget("TOOL_TIMEOUT_MS", TOOL_TIMEOUT_MS_DEFAULT, env),
        maxConcurrentTools: resolveEnvBudget("TURN_MAX_CONCURRENT_TOOLS", TURN_MAX_CONCURRENT_TOOLS_DEFAULT, env),
        toolArtifactOffloadThresholdChars: resolveEnvBudget(
            "TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS",
            TOOL_ARTIFACT_OFFLOAD_THRESHOLD_CHARS,
            env,
        ),
    };
}

/**
 * Apply budget guardrails to a prompt string.
 *
 * Hard budget is checked first; if the hard limit fires, the prompt is
 * truncated and the function returns `decision: "hard"`.
 * Soft budget fires only when the hard limit did not — the prompt is
 * unchanged but the caller should emit a trace warning.
 * Returns `decision: "ok"` when neither limit is exceeded.
 *
 * Never throws.
 */
export function applyTurnBudget(text: string, config: TurnBudgetConfig): TurnBudgetResult {
    const originalChars = text.length;

    if (config.hardBudgetChars > 0 && originalChars > config.hardBudgetChars) {
        _throttledTurns++;
        const roomForContent = config.hardBudgetChars - HARD_TRUNCATION_NOTICE.length;
        const truncated = roomForContent > 0
            ? text.slice(0, roomForContent) + HARD_TRUNCATION_NOTICE
            : HARD_TRUNCATION_NOTICE.slice(0, config.hardBudgetChars);
        return {
            decision: "hard",
            originalChars,
            effectiveChars: truncated.length,
            text: truncated,
        };
    }

    if (config.softBudgetChars > 0 && originalChars > config.softBudgetChars) {
        _throttledTurns++;
        return {
            decision: "soft",
            originalChars,
            effectiveChars: originalChars,
            text,
        };
    }

    return {
        decision: "ok",
        originalChars,
        effectiveChars: originalChars,
        text,
    };
}

function trimToBudget(text: string, maxChars: number, notice: string): BudgetedOutputResult {
    const originalChars = text.length;
    if (maxChars <= 0 || originalChars <= maxChars) {
        return {
            originalChars,
            effectiveChars: originalChars,
            trimmed: false,
            text,
        };
    }

    _throttledTurns++;
    const roomForContent = maxChars - notice.length;
    const trimmedText = roomForContent > 0
        ? text.slice(0, roomForContent) + notice
        : notice.slice(0, maxChars);

    return {
        originalChars,
        effectiveChars: trimmedText.length,
        trimmed: true,
        text: trimmedText,
    };
}

export function stringifyForModel(value: unknown): string {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/**
 * Truncate `text` to at most `maxChars`, preferring a clean line boundary.
 * If a newline exists in the last 20% of the allowed window, cut there to
 * avoid mid-line breaks. Appends a notice with original character counts.
 * Returns `text` unchanged when it fits within `maxChars`.
 */
export function smartTruncate(text: string, maxChars: number, label?: string): string {
    if (maxChars <= 0 || text.length <= maxChars) return text;
    _throttledTurns++;
    const slice = text.slice(0, maxChars);
    const lastNewline = slice.lastIndexOf("\n");
    const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;
    const kept = text.slice(0, cutPoint).trimEnd();
    return kept + `\n\n[${label ?? "Output"} truncated: showing first ${kept.length} of ${text.length} chars]`;
}

export function applyToolOutputBudget(
    value: unknown,
    config: TurnBudgetConfig,
): BudgetedOutputResult {
    const text = stringifyForModel(value);
    return trimToBudget(text, config.toolOutputHardBudgetChars, TOOL_OUTPUT_TRUNCATION_NOTICE);
}

export function applyAssistantOutputBudget(
    value: string,
    config: TurnBudgetConfig,
): BudgetedOutputResult {
    const originalChars = value.length;
    if (config.assistantOutputHardBudgetChars <= 0 || originalChars <= config.assistantOutputHardBudgetChars) {
        return { originalChars, effectiveChars: originalChars, trimmed: false, text: value };
    }
    return trimToBudget(
        value,
        config.assistantOutputHardBudgetChars,
        ASSISTANT_OUTPUT_TRUNCATION_NOTICE,
    );
}

/** Number of turns that hit a soft or hard budget limit since process start. */
export function getTurnBudgetThrottledCount(): number {
    return _throttledTurns;
}

/** Reset the throttle counter. For use in tests only. */
export function resetTurnBudgetStats(): void {
    _throttledTurns = 0;
}
