import type { SessionContextUsage } from "../types.js";

// ─── Prompt / system-context manipulation ───────────────────

export function cloneContextUsage(contextUsage?: SessionContextUsage): SessionContextUsage | undefined {
    if (!contextUsage) return undefined;
    return {
        ...contextUsage,
        ...(contextUsage.compaction ? { compaction: { ...contextUsage.compaction } } : {}),
    };
}

export function mergePrompt(existingPrompt?: string, nextPrompt?: string): string | undefined {
    if (!existingPrompt) return nextPrompt;
    if (!nextPrompt) return existingPrompt;
    return `${existingPrompt}\n\n${nextPrompt}`;
}

export function extractPromptSystemContext(rawPrompt?: string): { prompt?: string; systemPrompt?: string } {
    if (!rawPrompt) return {};

    const trimmed = rawPrompt.trim();
    if (trimmed.startsWith("[SYSTEM:") && trimmed.endsWith("]")) {
        return {
            systemPrompt: trimmed.slice("[SYSTEM:".length, -1).trim(),
        };
    }

    const marker = rawPrompt.lastIndexOf("\n\n[SYSTEM:");
    if (marker >= 0 && rawPrompt.trimEnd().endsWith("]")) {
        const prompt = rawPrompt.slice(0, marker).trim();
        const systemPrompt = rawPrompt.slice(marker + 2).trim();
        return {
            ...(prompt ? { prompt } : {}),
            systemPrompt: systemPrompt.slice("[SYSTEM:".length, -1).trim(),
        };
    }

    return { prompt: rawPrompt };
}

export function appendSystemContext(rawPrompt: string | undefined, extraSystemPrompt?: string): string | undefined {
    if (!extraSystemPrompt) return rawPrompt;
    const extracted = extractPromptSystemContext(rawPrompt);
    const mergedSystemPrompt = mergePrompt(extracted.systemPrompt, extraSystemPrompt);
    if (!mergedSystemPrompt) return extracted.prompt ?? rawPrompt;
    if (extracted.prompt) {
        return `${extracted.prompt}\n\n[SYSTEM: ${mergedSystemPrompt}]`;
    }
    return `[SYSTEM: ${mergedSystemPrompt}]`;
}

export function validClientMessageIds(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((id: unknown): id is string => typeof id === "string" && Boolean(id))
        : [];
}

// ─── Context usage event reduction ──────────────────────────

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

export function updateContextUsageFromEvents(
    previous: SessionContextUsage | undefined,
    events: Array<{ eventType?: string; data?: any }> | undefined,
    observedAt: number,
): SessionContextUsage | undefined {
    let next = cloneContextUsage(previous);
    if (!Array.isArray(events) || events.length === 0) return next;

    for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const eventType = event.eventType;
        const data = event.data;
        if (!eventType || !data || typeof data !== "object") continue;

        if (eventType === "session.usage_info") {
            const tokenLimit = finiteNumber(data.tokenLimit);
            const currentTokens = finiteNumber(data.currentTokens);
            const messagesLength = finiteNumber(data.messagesLength);
            if (tokenLimit == null || currentTokens == null || messagesLength == null) continue;

            next = {
                ...(next ?? {}),
                tokenLimit,
                currentTokens,
                utilization: tokenLimit > 0 ? currentTokens / tokenLimit : 0,
                messagesLength,
                updatedAt: observedAt,
            };

            const systemTokens = finiteNumber(data.systemTokens);
            if (systemTokens != null) next.systemTokens = systemTokens;
            const conversationTokens = finiteNumber(data.conversationTokens);
            if (conversationTokens != null) next.conversationTokens = conversationTokens;
            const toolDefinitionsTokens = finiteNumber(data.toolDefinitionsTokens);
            if (toolDefinitionsTokens != null) next.toolDefinitionsTokens = toolDefinitionsTokens;
            const isInitial = optionalBoolean(data.isInitial);
            if (isInitial != null) next.isInitial = isInitial;
            continue;
        }

        if (!next) continue;

        if (eventType === "assistant.usage") {
            const inputTokens = finiteNumber(data.inputTokens);
            if (inputTokens != null) next.lastInputTokens = inputTokens;
            const outputTokens = finiteNumber(data.outputTokens);
            if (outputTokens != null) next.lastOutputTokens = outputTokens;
            const cacheReadTokens = finiteNumber(data.cacheReadTokens);
            if (cacheReadTokens != null) next.lastCacheReadTokens = cacheReadTokens;
            const cacheWriteTokens = finiteNumber(data.cacheWriteTokens);
            if (cacheWriteTokens != null) next.lastCacheWriteTokens = cacheWriteTokens;
            next.updatedAt = observedAt;
            continue;
        }

        if (eventType === "session.compaction_start") {
            const compaction = {
                ...(next.compaction ?? { state: "idle" as const }),
                state: "running" as const,
                startedAt: observedAt,
                completedAt: undefined,
                error: undefined,
            };
            next.compaction = compaction;
            next.updatedAt = observedAt;
            continue;
        }

        if (eventType === "session.compaction_complete") {
            const compaction: NonNullable<SessionContextUsage["compaction"]> = {
                ...(next.compaction ?? { state: "idle" }),
                state: data.success === false ? "failed" : "succeeded",
                completedAt: observedAt,
            };
            if (typeof data.error === "string" && data.error) compaction.error = data.error;
            else delete compaction.error;

            const preCompactionTokens = finiteNumber(data.preCompactionTokens);
            if (preCompactionTokens != null) compaction.preCompactionTokens = preCompactionTokens;
            const postCompactionTokens = finiteNumber(data.postCompactionTokens);
            if (postCompactionTokens != null) compaction.postCompactionTokens = postCompactionTokens;
            const preCompactionMessagesLength = finiteNumber(data.preCompactionMessagesLength);
            if (preCompactionMessagesLength != null) compaction.preCompactionMessagesLength = preCompactionMessagesLength;
            const messagesRemoved = finiteNumber(data.messagesRemoved);
            if (messagesRemoved != null) compaction.messagesRemoved = messagesRemoved;
            const tokensRemoved = finiteNumber(data.tokensRemoved);
            if (tokensRemoved != null) compaction.tokensRemoved = tokensRemoved;
            const systemTokens = finiteNumber(data.systemTokens);
            if (systemTokens != null) compaction.systemTokens = systemTokens;
            const conversationTokens = finiteNumber(data.conversationTokens);
            if (conversationTokens != null) compaction.conversationTokens = conversationTokens;
            const toolDefinitionsTokens = finiteNumber(data.toolDefinitionsTokens);
            if (toolDefinitionsTokens != null) compaction.toolDefinitionsTokens = toolDefinitionsTokens;

            const compactionTokensUsed = data.compactionTokensUsed && typeof data.compactionTokensUsed === "object"
                ? data.compactionTokensUsed
                : null;
            if (compactionTokensUsed) {
                const compactionInputTokens = finiteNumber(compactionTokensUsed.input);
                if (compactionInputTokens != null) compaction.inputTokens = compactionInputTokens;
                const compactionOutputTokens = finiteNumber(compactionTokensUsed.output);
                if (compactionOutputTokens != null) compaction.outputTokens = compactionOutputTokens;
                const compactionCachedInputTokens = finiteNumber(compactionTokensUsed.cachedInput);
                if (compactionCachedInputTokens != null) compaction.cachedInputTokens = compactionCachedInputTokens;
            }

            if (postCompactionTokens != null) {
                next.currentTokens = postCompactionTokens;
                next.utilization = next.tokenLimit > 0 ? postCompactionTokens / next.tokenLimit : 0;
            }
            if (preCompactionMessagesLength != null && messagesRemoved != null) {
                next.messagesLength = Math.max(0, preCompactionMessagesLength - messagesRemoved);
            }
            if (systemTokens != null) next.systemTokens = systemTokens;
            if (conversationTokens != null) next.conversationTokens = conversationTokens;
            if (toolDefinitionsTokens != null) next.toolDefinitionsTokens = toolDefinitionsTokens;
            next.compaction = compaction;
            next.updatedAt = observedAt;
        }
    }

    return next;
}

// ─── Error / retry classification ───────────────────────────

export const COPILOT_CONNECTION_CLOSED_MAX_RETRIES = 3;
export const COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS = 15;

export function isCopilotConnectionClosedError(message?: string): boolean {
    return /\bConnection is closed\b/i.test(String(message || ""));
}

export function isAuthFailureError(message?: string): boolean {
    const text = String(message || "");
    return (
        /\bNo authentication info available\b/i.test(text)
        || /\bBad credentials\b/i.test(text)
        || /\bAuthentication failed\b/i.test(text)
        || /\bunauthorized\b/i.test(text)
        || /\b401\b/.test(text)
    );
}

export const AUTH_FAILURE_USER_HINT =
    "GitHub Copilot rejected the authentication token. " +
    "Open the Admin Console (portal toolbar 'Admin' button or TUI Shift+A) " +
    "to update your GitHub Copilot key, then resend the prompt to retry.";

export function buildConnectionClosedRetryDetail(retryAttempt: number): string {
    return `Live Copilot connection lost; retry ${retryAttempt}/${COPILOT_CONNECTION_CLOSED_MAX_RETRIES} in ${COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS}s.`;
}

export function buildLossyHandoffSummary(errorMessage: string): string {
    return `Live Copilot connection stayed closed after ${COPILOT_CONNECTION_CLOSED_MAX_RETRIES} retries; ` +
        `dehydrating for handoff to a new worker. Last error: ${errorMessage}`;
}

export function buildLossyHandoffRehydrationMessage(errorMessage: string): string {
    return `The previous worker lost the live Copilot connection and handed this session off after ` +
        `${COPILOT_CONNECTION_CLOSED_MAX_RETRIES} retries. The LLM conversation history is preserved. ` +
        `Review the latest durable context and continue carefully. Last transport error: ${errorMessage}`;
}
