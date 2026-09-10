const FIELD_ALIASES = Object.freeze({
    author: "author",
    owner: "author",
    agent: "agent",
    status: "status",
    group: "group",
    folder: "group",
    model: "model",
    id: "id",
    topic: "topic",
    summary: "summary",
});

const FREE_FIELD_WEIGHTS = Object.freeze({
    title: 12,
    id: 11,
    author: 10,
    agent: 9,
    summary: 7,
    group: 6,
    model: 5,
    status: 4,
});

export function normalizeSessionSearchText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9@._+-]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export function parseSessionSearchQuery(value) {
    const source = String(value || "").trim();
    const terms = [];
    const filters = [];
    const pattern = /(?:(\w+):)?(?:"([^"]+)"|(\S+))/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const rawField = String(match[1] || "").toLowerCase();
        const rawValue = match[2] ?? match[3] ?? "";
        const normalized = normalizeSessionSearchText(rawValue);
        if (!normalized) continue;
        const field = FIELD_ALIASES[rawField];
        if (field) filters.push({ field, value: normalized });
        else terms.push(normalizeSessionSearchText(rawField ? `${rawField} ${rawValue}` : rawValue));
    }
    return { source, terms: terms.filter(Boolean), filters };
}

function boundedDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        let rowMinimum = current[0];
        for (let j = 1; j <= b.length; j += 1) {
            const value = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            current.push(value);
            rowMinimum = Math.min(rowMinimum, value);
        }
        if (rowMinimum > limit) return limit + 1;
        previous = current;
    }
    return previous[b.length];
}

function matchStrength(haystack, needle) {
    if (!haystack || !needle) return 0;
    if (haystack === needle) return 16;
    const words = haystack.split(" ");
    if (words.includes(needle)) return 14;
    if (haystack.includes(needle)) return needle.includes(" ") ? 13 : 11;
    if (needle.length >= 2 && words.some((word) => word.startsWith(needle))) return 9;
    if (needle.length >= 4 && words.some((word) => word.includes(needle))) return 7;
    if (needle.length < 4) return 0;
    // One adjacent transposition is two edits under Levenshtein distance
    // ("session" → "sessoin"). Permit that for ordinary words while keeping
    // short tokens exact/prefix-only.
    const limit = needle.length >= 6 ? 2 : 1;
    return words.some((word) => boundedDistance(word, needle, limit) <= limit) ? 4 : 0;
}

function summaryStrings(summaryState) {
    if (!summaryState || typeof summaryState !== "object") return [];
    return [summaryState.topic, summaryState.intent, summaryState.summary, summaryState.title]
        .filter((value) => typeof value === "string" && value.trim());
}

export function buildSessionSearchDocument(session, { owner = null, groupTitle = "" } = {}) {
    const title = normalizeSessionSearchText(session?.title);
    const summary = normalizeSessionSearchText([
        session?.shortSummary,
        ...summaryStrings(session?.summaryState),
    ].filter(Boolean).join(" "));
    const author = normalizeSessionSearchText([
        owner?.displayName,
        owner?.email,
        owner?.subject,
    ].filter(Boolean).join(" "));
    return {
        title,
        summary,
        topic: normalizeSessionSearchText(`${title} ${summary}`),
        author,
        agent: normalizeSessionSearchText(session?.agentId),
        status: normalizeSessionSearchText(session?.status),
        group: normalizeSessionSearchText(groupTitle),
        model: normalizeSessionSearchText(`${session?.model || ""} ${session?.reasoningEffort || ""}`),
        id: normalizeSessionSearchText(session?.sessionId),
    };
}

/**
 * Score one already-authorized, browser-resident session. Structured filters
 * and free-text terms are ANDed; each free term may match any field. Exact,
 * prefix and substring matches beat bounded typo matches.
 */
export function scoreSessionSearchDocument(document, query) {
    const parsed = typeof query === "string" ? parseSessionSearchQuery(query) : query;
    if (!parsed || (parsed.terms.length === 0 && parsed.filters.length === 0)) return 1;
    let score = 0;
    for (const filter of parsed.filters) {
        const strength = matchStrength(document?.[filter.field] || "", filter.value);
        if (!strength) return 0;
        score += strength * 14;
    }
    for (const term of parsed.terms) {
        let best = 0;
        for (const [field, weight] of Object.entries(FREE_FIELD_WEIGHTS)) {
            // Short numbers such as "Session 2" occur in the fixed portions
            // of every UUID. Treat IDs as an explicit/long-fragment field so
            // the human title remains the natural interpretation; `id:...`
            // is always available for deliberate ID lookup.
            if (field === "id" && (/^\d+$/.test(term) || term.length < 8)) continue;
            best = Math.max(best, matchStrength(document?.[field] || "", term) * weight);
        }
        if (!best) return 0;
        score += best;
    }
    const phrase = parsed.terms.join(" ");
    if (phrase && document?.title?.includes(phrase)) score += 120;
    else if (phrase && document?.summary?.includes(phrase)) score += 60;
    return score;
}
