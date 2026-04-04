export function computeContextPercent(contextUsage) {
    const utilization = typeof contextUsage?.utilization === "number"
        ? contextUsage.utilization
        : (typeof contextUsage?.tokenLimit === "number"
            && contextUsage.tokenLimit > 0
            && typeof contextUsage?.currentTokens === "number"
            ? contextUsage.currentTokens / contextUsage.tokenLimit
            : null);

    if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
    return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

export function formatTokenCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
    if (value >= 1_000_000) {
        const compact = value >= 10_000_000
            ? Math.round(value / 1_000_000)
            : Math.round(value / 100_000) / 10;
        return `${compact}`.replace(/\.0$/, "") + "m";
    }
    if (value >= 1_000) {
        const compact = value >= 100_000
            ? Math.round(value / 1_000)
            : Math.round(value / 100) / 10;
        return `${compact}`.replace(/\.0$/, "") + "k";
    }
    return String(Math.round(value));
}

export function getContextMeterColor(contextUsage) {
    const percent = computeContextPercent(contextUsage);
    if (percent == null) return "gray";
    if (percent >= 85) return "red";
    if (percent >= 70) return "yellow";
    return "gray";
}

export function getContextHeaderBadge(contextUsage) {
    if (!contextUsage) return null;
    if (!(typeof contextUsage.tokenLimit === "number"
        && contextUsage.tokenLimit > 0
        && typeof contextUsage.currentTokens === "number"
        && contextUsage.currentTokens >= 0)) {
        return null;
    }

    const percent = computeContextPercent(contextUsage);
    if (percent == null) return null;

    return {
        text: `ctx ${formatTokenCount(contextUsage.currentTokens)}/${formatTokenCount(contextUsage.tokenLimit)} ${percent}%`,
        color: getContextMeterColor(contextUsage),
    };
}

export function getContextListBadge(contextUsage) {
    if (!contextUsage) return null;

    const compaction = contextUsage.compaction;
    if (compaction?.state === "running") {
        return { text: "[compact]", color: "magenta" };
    }
    if (compaction?.state === "failed") {
        return { text: "[compact !]", color: "red" };
    }

    const percent = computeContextPercent(contextUsage);
    if (percent == null || percent < 70) return null;

    return {
        text: `[ctx ${percent}%]`,
        color: percent >= 85 ? "red" : "yellow",
    };
}

export function getContextCompactionBadge(contextUsage) {
    const compaction = contextUsage?.compaction;
    if (!compaction || typeof compaction !== "object") return null;

    if (compaction.state === "running") {
        return { text: "[compacting]", color: "magenta" };
    }
    if (compaction.state === "failed") {
        return { text: "[compact failed]", color: "red" };
    }
    return null;
}

export function cloneContextUsageSnapshot(contextUsage) {
    if (!contextUsage || typeof contextUsage !== "object") return null;
    return {
        ...contextUsage,
        ...(contextUsage.compaction && typeof contextUsage.compaction === "object"
            ? { compaction: { ...contextUsage.compaction } }
            : {}),
    };
}

function normalizeUsageTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    const numeric = new Date(value).getTime();
    return Number.isFinite(numeric) ? numeric : Date.now();
}

export function applySessionUsageEvent(contextUsage, eventType, data = {}, options = {}) {
    if (!eventType) return null;
    const current = cloneContextUsageSnapshot(contextUsage) || {};
    const timestamp = normalizeUsageTimestamp(options.timestamp);

    if (eventType === "session.usage_info") {
        if (typeof data.tokenLimit !== "number"
            || typeof data.currentTokens !== "number"
            || typeof data.messagesLength !== "number") {
            return null;
        }
        current.tokenLimit = data.tokenLimit;
        current.currentTokens = data.currentTokens;
        current.messagesLength = data.messagesLength;
        current.utilization = data.tokenLimit > 0 ? data.currentTokens / data.tokenLimit : 0;
        if (typeof data.systemTokens === "number") current.systemTokens = data.systemTokens;
        if (typeof data.conversationTokens === "number") current.conversationTokens = data.conversationTokens;
        if (typeof data.toolDefinitionsTokens === "number") current.toolDefinitionsTokens = data.toolDefinitionsTokens;
        if (typeof data.isInitial === "boolean") current.isInitial = data.isInitial;
        return current;
    }

    if (eventType === "assistant.usage") {
        if (typeof data.inputTokens === "number") current.lastInputTokens = data.inputTokens;
        if (typeof data.outputTokens === "number") current.lastOutputTokens = data.outputTokens;
        if (typeof data.cacheReadTokens === "number") current.lastCacheReadTokens = data.cacheReadTokens;
        if (typeof data.cacheWriteTokens === "number") current.lastCacheWriteTokens = data.cacheWriteTokens;
        return current;
    }

    if (eventType === "session.compaction_start") {
        current.compaction = {
            ...(current.compaction || {}),
            state: "running",
            startedAt: timestamp,
            completedAt: undefined,
            error: undefined,
        };
        return current;
    }

    if (eventType === "session.compaction_complete") {
        current.compaction = {
            ...(current.compaction || {}),
            state: data.success === false ? "failed" : "succeeded",
            completedAt: timestamp,
            error: typeof data.error === "string" ? data.error : undefined,
            preCompactionTokens: typeof data.preCompactionTokens === "number" ? data.preCompactionTokens : undefined,
            postCompactionTokens: typeof data.postCompactionTokens === "number" ? data.postCompactionTokens : undefined,
            preCompactionMessagesLength: typeof data.preCompactionMessagesLength === "number" ? data.preCompactionMessagesLength : undefined,
            messagesRemoved: typeof data.messagesRemoved === "number" ? data.messagesRemoved : undefined,
            tokensRemoved: typeof data.tokensRemoved === "number" ? data.tokensRemoved : undefined,
            systemTokens: typeof data.systemTokens === "number" ? data.systemTokens : undefined,
            conversationTokens: typeof data.conversationTokens === "number" ? data.conversationTokens : undefined,
            toolDefinitionsTokens: typeof data.toolDefinitionsTokens === "number" ? data.toolDefinitionsTokens : undefined,
            inputTokens: typeof data.compactionTokensUsed?.input === "number" ? data.compactionTokensUsed.input : undefined,
            outputTokens: typeof data.compactionTokensUsed?.output === "number" ? data.compactionTokensUsed.output : undefined,
            cachedInputTokens: typeof data.compactionTokensUsed?.cachedInput === "number" ? data.compactionTokensUsed.cachedInput : undefined,
        };

        if (typeof data.postCompactionTokens === "number" && typeof current.tokenLimit === "number" && current.tokenLimit > 0) {
            current.currentTokens = data.postCompactionTokens;
            current.utilization = data.postCompactionTokens / current.tokenLimit;
        }
        if (typeof data.preCompactionMessagesLength === "number" && typeof data.messagesRemoved === "number") {
            current.messagesLength = Math.max(0, data.preCompactionMessagesLength - data.messagesRemoved);
        }
        if (typeof data.systemTokens === "number") current.systemTokens = data.systemTokens;
        if (typeof data.conversationTokens === "number") current.conversationTokens = data.conversationTokens;
        if (typeof data.toolDefinitionsTokens === "number") current.toolDefinitionsTokens = data.toolDefinitionsTokens;
        return current;
    }

    return null;
}

export function formatCompactionActivityRuns(timestamp, eventType, data = {}) {
    const prefix = timestamp ? [{ text: `[${timestamp}] `, color: "white" }] : [];

    if (eventType === "session.compaction_start") {
        return [
            ...prefix,
            { text: "[compaction]", color: "magenta" },
            { text: " started", color: "white" },
        ];
    }

    if (data.success === false) {
        return [
            ...prefix,
            { text: "[compaction]", color: "red" },
            { text: " failed", color: "white" },
            ...(typeof data.error === "string" && data.error
                ? [{ text: `: ${data.error}`, color: "red" }]
                : []),
        ];
    }

    return [
        ...prefix,
        { text: "[compaction]", color: "magenta" },
        { text: " complete", color: "white" },
        ...(typeof data.tokensRemoved === "number"
            ? [{ text: ` freed ${formatTokenCount(data.tokensRemoved)}`, color: "gray" }]
            : []),
    ];
}
