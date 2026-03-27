export function computeContextPercent(contextUsage) {
    const utilization = typeof contextUsage?.utilization === "number"
        ? contextUsage.utilization
        : (typeof contextUsage?.tokenLimit === "number" && contextUsage.tokenLimit > 0
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

export function formatContextHeaderBadge(contextUsage) {
    if (!contextUsage) return "";
    if (!(typeof contextUsage.tokenLimit === "number" && contextUsage.tokenLimit > 0
        && typeof contextUsage.currentTokens === "number" && contextUsage.currentTokens >= 0)) {
        return "";
    }
    const percent = computeContextPercent(contextUsage);
    if (percent == null) return "";
    const color = getContextMeterColor(contextUsage);
    return ` {${color}-fg}ctx ${formatTokenCount(contextUsage.currentTokens)}/${formatTokenCount(contextUsage.tokenLimit)} ${percent}%{/${color}-fg}`;
}

export function formatContextListBadge(contextUsage) {
    if (!contextUsage) return "";
    const compaction = contextUsage.compaction;
    if (compaction?.state === "running") return " {magenta-fg}[compact]{/magenta-fg}";
    if (compaction?.state === "failed") return " {red-fg}[compact !]{/red-fg}";
    const percent = computeContextPercent(contextUsage);
    if (percent == null || percent < 70) return "";
    const color = percent >= 85 ? "red" : "yellow";
    return ` {${color}-fg}[ctx ${percent}%]{/${color}-fg}`;
}

export function formatContextCompactionBadge(contextUsage) {
    const compaction = contextUsage?.compaction;
    if (!compaction || typeof compaction !== "object") return "";
    if (compaction.state === "running") return " {magenta-fg}[compacting]{/magenta-fg}";
    if (compaction.state === "failed") return " {red-fg}[compact failed]{/red-fg}";
    return "";
}

export function formatCompactionActivityMarkup(timestamp, eventType, data = {}) {
    if (eventType === "session.compaction_start") {
        return `{white-fg}[${timestamp}]{/white-fg} {magenta-fg}[compaction]{/magenta-fg} started`;
    }
    if (data.success === false) {
        const reason = typeof data.error === "string" && data.error ? `: ${data.error}` : "";
        return `{white-fg}[${timestamp}]{/white-fg} {red-fg}[compaction]{/red-fg} failed${reason}`;
    }
    const removed = typeof data.tokensRemoved === "number"
        ? ` freed ${formatTokenCount(data.tokensRemoved)}`
        : "";
    return `{white-fg}[${timestamp}]{/white-fg} {magenta-fg}[compaction]{/magenta-fg} complete${removed}`;
}
