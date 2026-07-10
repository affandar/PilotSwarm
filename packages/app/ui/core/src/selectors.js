import { INSPECTOR_TABS, FOCUS_REGIONS } from "./commands.js";
import {
    createSplashCard,
    isRehydrationNoticeText,
    parseAskedAndAnsweredExchange,
    stripLeadingRehydrationNoticeText,
} from "./history.js";
import {
    buildMessageCardLines,
    decorateArtifactLinksForChat,
    extractArtifactLinks,
    extractHttpLinks,
    formatHumanDurationSeconds,
    formatTimestamp,
    padRunsToDisplayWidth,
    parseMarkdownLines,
    shortModelName,
    shortSessionId,
    stripTerminalMarkupTags,
    wrapRunsToDisplayWidth,
} from "./formatting.js";
import {
    computeContextPercent,
    getContextCompactionBadge,
    getContextHeaderBadge,
} from "./context-usage.js";
import { canonicalSystemTitle } from "./system-titles.js";
import { normalizeArtifactEntries } from "./state.js";
import { isRecoverableTransportErrorText } from "./session-errors.js";

export const ACTIVE_HIGHLIGHT_BACKGROUND = "activeHighlightBackground";
export const ACTIVE_HIGHLIGHT_FOREGROUND = "activeHighlightForeground";
const USER_CHAT_COLOR = "userChat";
const USER_CHAT_LABEL_COLOR = "userChatLabel";

const totalDescendantCountsCache = new WeakMap();
const visibleDescendantCountsCache = new WeakMap();

export function resolveActiveHighlightColor(color) {
    return color || ACTIVE_HIGHLIGHT_FOREGROUND;
}

export function applyActiveHighlightRuns(runs, { preserveColors = false } = {}) {
    return (runs || []).map((run) => ({
        ...run,
        color: preserveColors ? resolveActiveHighlightColor(run?.color) : ACTIVE_HIGHLIGHT_FOREGROUND,
        backgroundColor: ACTIVE_HIGHLIGHT_BACKGROUND,
        bold: run?.bold ?? true,
    }));
}

export function buildActiveHighlightLine(text, { color = ACTIVE_HIGHLIGHT_FOREGROUND, bold = true } = {}) {
    return {
        text,
        color,
        backgroundColor: ACTIVE_HIGHLIGHT_BACKGROUND,
        bold,
    };
}

function buildPaneTitleRuns(text, color) {
    return [{
        text: String(text || ""),
        color,
        bold: true,
    }];
}

const COMPACT_PANE_TITLE_METADATA_WIDTH = 72;

function shouldCompactPaneTitleMetadata(width) {
    const safeWidth = Number(width) || 0;
    return safeWidth > 0 && safeWidth <= COMPACT_PANE_TITLE_METADATA_WIDTH;
}

function getSessionVisualStatus(session) {
    if (!session) return "unknown";
    const status = session.status || "unknown";
    if (
        session.cronActive === true
        && (status === "waiting" || status === "idle" || status === "unknown")
    ) {
        return "cron_waiting";
    }
    return status;
}

function getSessionSummaryStatusLabel(session) {
    const status = getSessionVisualStatus(session);
    if (!status || status === "unknown") return "";
    return status === "cron_waiting" ? "waiting" : status;
}

function getSessionRowStatusLabel(session) {
    // List-row text uses the debounced row status (5s hold, see
    // mergeSessionRowVisualStatus) rather than the raw one: the 4s catalog
    // poll (CMS row state) and the post-event detail sync (live orchestration
    // customStatus) can disagree mid-turn, and rendering the raw value makes
    // the label flap even though the row color (sessionStatusColor) is
    // already smoothed. The summary view keeps the immediate raw label above.
    const status = getSessionRowVisualStatus(session);
    if (!status || status === "unknown") return "";
    return status === "cron_waiting" ? "waiting" : status;
}

function getSessionRowVisualStatus(session) {
    return session?.rowVisualStatus || getSessionVisualStatus(session);
}

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function getSessionErrorVisualKind(session) {
    const status = getSessionVisualStatus(session);
    if (session?.orchestrationStatus === "Failed" || status === "failed") return "failed";
    if (status === "error") return "warning";
    if (status === "running" && isRecoverableTransportErrorText(session?.error) && !isTerminalOrchestrationStatus(session?.orchestrationStatus)) return "warning";
    return null;
}

function getSessionVisualKind(session, mode = "local") {
    const errorKind = getSessionErrorVisualKind(session);
    if (errorKind) return errorKind;

    const status = getSessionVisualStatus(session);
    if (
        mode === "remote"
        && isTerminalOrchestrationStatus(session?.orchestrationStatus)
        && status !== "cron_waiting"
        && status !== "waiting"
        && status !== "input_required"
    ) {
        if (session?.orchestrationStatus === "Completed") return "completed";
        if (session?.orchestrationStatus === "Terminated") return "terminated";
    }
    if (status === "terminated") return "terminated";
    return status;
}

function getSessionRowVisualKind(session, mode = "local") {
    const errorKind = getSessionErrorVisualKind(session);
    if (errorKind) return errorKind;

    const status = getSessionRowVisualStatus(session);
    if (
        mode === "remote"
        && isTerminalOrchestrationStatus(session?.orchestrationStatus)
        && status !== "cron_waiting"
        && status !== "waiting"
        && status !== "input_required"
    ) {
        if (session?.orchestrationStatus === "Completed") return "completed";
        if (session?.orchestrationStatus === "Terminated") return "terminated";
    }
    if (status === "terminated") return "terminated";
    return status;
}

function sessionStatusColor(session, mode = "local") {
    switch (getSessionRowVisualKind(session, mode)) {
        case "running": return "green";
        case "cron_waiting": return "yellow";
        case "waiting": return "yellow";
        case "input_required": return "cyan";
        case "cancelled": return "gray";
        case "warning": return "yellow";
        case "failed": return "red";
        case "terminated": return "gray";
        case "completed": return "gray";
        case "idle": return "white";
        default: return "white";
    }
}

function sessionStatusIcon(session, mode = "local") {
    switch (getSessionRowVisualKind(session, mode)) {
        case "running": return "*";
        case "cron_waiting": return "~";
        case "waiting": return "~";
        case "input_required": return "?";
        case "cancelled": return "x";
        case "warning": return "!";
        case "failed":
        case "terminated": return "x";
        case "idle": return "";
        default: return "";
    }
}

function ownerKeyForOwner(owner) {
    const provider = String(owner?.provider || "").trim();
    const subject = String(owner?.subject || "").trim();
    return provider && subject ? `${provider}\u0001${subject}` : null;
}

function ownerDisplayName(owner, fallback = "unknown user") {
    return String(owner?.displayName || owner?.email || "").trim() || fallback;
}

function initialsFromText(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const parts = text
        .replace(/@.*/u, "")
        .split(/[^A-Za-z0-9]+/u)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toLowerCase();
    const compact = (parts[0] || text).replace(/[^A-Za-z0-9]/gu, "");
    return compact.slice(0, 2).toLowerCase();
}

function ownerInitials(owner) {
    return initialsFromText(owner?.displayName) || initialsFromText(owner?.email) || "?";
}

function shouldDecorateSessionOwners(state) {
    // Decorate owners only when the list actually surfaces more than one
    // distinct human owner — otherwise the owner chip is pure noise on every
    // row (you are always "you"). A narrowed owner filter is an explicit
    // multi-user context, so honor that too.
    if (state.sessions?.ownerFilter && state.sessions.ownerFilter.all !== true) return true;
    const owners = new Set();
    for (const session of Object.values(state.sessions?.byId || {})) {
        if (!session || session.isSystem || session.isGroup) continue;
        const key = ownerKeyForOwner(session.owner);
        if (!key) continue;
        owners.add(key);
        if (owners.size > 1) return true;
    }
    return false;
}

function groupMemberSessions(group, byId = {}) {
    if (!group?.isGroup || !group?.groupId) return [];
    return Object.values(byId || {}).filter((session) => (
        session
        && !session.isGroup
        && !session.parentSessionId
        && session.groupId === group.groupId
    ));
}

function effectiveSessionOwner(session, byId = {}) {
    if (!session?.isGroup) return session?.owner ?? null;
    if (session.owner) return session.owner;
    const ownersByKey = new Map();
    for (const member of groupMemberSessions(session, byId)) {
        const key = ownerKeyForOwner(member?.owner);
        if (key && !ownersByKey.has(key)) ownersByKey.set(key, member.owner);
    }
    return ownersByKey.size === 1 ? ownersByKey.values().next().value : null;
}

function normalizeAgentTitleComparable(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function isLikelyAgentTitlePrefix(prefix, session) {
    const comparablePrefix = normalizeAgentTitleComparable(prefix);
    const comparableAgentId = normalizeAgentTitleComparable(session?.agentId);
    return Boolean(comparablePrefix && comparableAgentId && comparablePrefix === comparableAgentId);
}

function splitAgentPrefixedSessionTitle(session) {
    if (!session?.agentId || session?.isSystem) return null;
    const currentTitle = String(session?.title || "").trim();
    if (!currentTitle) return null;

    const suffixSeparator = " · ";
    const suffixIndex = currentTitle.lastIndexOf(suffixSeparator);
    if (suffixIndex > 0) {
        const displayTitle = currentTitle.slice(0, suffixIndex).trim();
        const agentTitle = currentTitle.slice(suffixIndex + suffixSeparator.length).trim();
        if (displayTitle && isLikelyAgentTitlePrefix(agentTitle, session)) {
            return { displayTitle, agentTitle };
        }
    }

    const dashMatch = /^(.+?)\s+[–—-]\s+(.+)$/u.exec(currentTitle);
    if (dashMatch) {
        const agentTitle = dashMatch[1].trim();
        const displayTitle = dashMatch[2].trim();
        if (agentTitle && displayTitle) return { displayTitle, agentTitle };
    }

    const separatorIndex = currentTitle.indexOf(": ");
    if (separatorIndex > 0) {
        const agentTitle = currentTitle.slice(0, separatorIndex).trim();
        const displayTitle = currentTitle.slice(separatorIndex + 2).trim();
        if (displayTitle && isLikelyAgentTitlePrefix(agentTitle, session)) {
            return { displayTitle, agentTitle };
        }
    }

    return null;
}

function splitTypedSessionTitle(displayTitle) {
    const title = String(displayTitle || "");
    const separatorIndex = title.indexOf(": ");
    if (separatorIndex <= 0) return null;
    const typeTitle = title.slice(0, separatorIndex).trim();
    const userTitle = title.slice(separatorIndex + 2).trim();
    if (!typeTitle || !userTitle) return null;
    return { userTitle, typeTitle };
}

function buildSessionDisplayTitle(session) {
    const title = String(session?.title || "").trim();
    const splitTitle = splitAgentPrefixedSessionTitle(session);
    if (!splitTitle) return title;
    const typedTitle = splitTypedSessionTitle(splitTitle.displayTitle);
    if (typedTitle) {
        return `${typedTitle.userTitle} · ${typedTitle.typeTitle} · ${splitTitle.agentTitle}`;
    }
    return `${splitTitle.displayTitle} · ${splitTitle.agentTitle}`;
}

function buildSessionTitle(session, brandingTitle) {
    const shortId = shortSessionId(session?.sessionId);

    if (session?.isSystem) {
        return `${canonicalSystemTitle(session, brandingTitle)} (${shortId})`;
    }

    const title = buildSessionDisplayTitle(session);
    if (!title) return `(${shortId})`;
    return title.includes(shortId) ? title : `${title} (${shortId})`;
}

function matchesOwnerFilterDirect(session, ownerFilter = {}, auth = {}, ownerOverride = undefined) {
    if (!ownerFilter || ownerFilter.all === true) return true;
    if (session?.isSystem) return ownerFilter.includeSystem === true;
    const ownerKey = ownerKeyForOwner(ownerOverride !== undefined ? ownerOverride : session?.owner);
    if (!ownerKey) return ownerFilter.includeUnowned === true;
    const currentUserKey = ownerKeyForOwner(auth?.principal);
    if (ownerFilter.includeMe && currentUserKey && ownerKey === currentUserKey) return true;
    return Array.isArray(ownerFilter.ownerKeys) && ownerFilter.ownerKeys.includes(ownerKey);
}

/**
 * A session passes the owner filter if it matches directly OR if any of
 * its ancestors matches. This keeps spawned children (which may be
 * unowned, e.g. when a system agent like Facts Manager spawns a named
 * agent on behalf of a user) visible under their visible parent. Without
 * this, the tree would silently drop the child and only show a `[+1]`
 * hidden-descendant badge on the parent — which is what the bug report
 * showed.
 */
function matchesOwnerFilter(session, ownerFilter = {}, auth = {}, byId = null) {
    const effectiveOwner = effectiveSessionOwner(session, byId || {});
    if (matchesOwnerFilterDirect(session, ownerFilter, auth, effectiveOwner)) return true;
    if (!byId) return false;
    if (session?.isGroup) {
        return groupMemberSessions(session, byId).some((member) => matchesOwnerFilter(member, ownerFilter, auth, byId));
    }
    let current = session;
    let hops = 0;
    while (current?.parentSessionId && hops < 16) {
        const parent = byId[current.parentSessionId];
        if (!parent) return false;
        if (matchesOwnerFilterDirect(parent, ownerFilter, auth)) return true;
        current = parent;
        hops += 1;
    }
    return false;
}

function flattenRunsText(runs) {
    return (runs || []).map((run) => run?.text || "").join("");
}

function buildChildMaps(byId) {
    const childMap = new Map();
    const parentMap = new Map();

    for (const session of Object.values(byId || {})) {
        const parentId = session?.parentSessionId;
        if (!parentId) continue;
        parentMap.set(session.sessionId, parentId);
        if (!childMap.has(parentId)) childMap.set(parentId, []);
        childMap.get(parentId).push(session.sessionId);
    }

    return { childMap, parentMap };
}

function buildTotalDescendantCounts(byId) {
    const { childMap } = buildChildMaps(byId);
    const counts = new Map();

    function countFor(sessionId) {
        if (counts.has(sessionId)) return counts.get(sessionId);
        const children = childMap.get(sessionId) || [];
        const total = children.reduce((sum, childId) => sum + 1 + countFor(childId), 0);
        counts.set(sessionId, total);
        return total;
    }

    for (const sessionId of Object.keys(byId || {})) {
        countFor(sessionId);
    }

    return counts;
}

function buildVisibleDescendantCounts(flat = [], byId = {}) {
    const { parentMap } = buildChildMaps(byId);
    const counts = new Map();

    for (const entry of flat) {
        let currentParentId = parentMap.get(entry.sessionId);
        while (currentParentId) {
            counts.set(currentParentId, (counts.get(currentParentId) || 0) + 1);
            currentParentId = parentMap.get(currentParentId);
        }
    }

    return counts;
}

function getTotalDescendantCounts(byId = {}) {
    if (!byId || typeof byId !== "object") {
        return buildTotalDescendantCounts(byId);
    }
    const cached = totalDescendantCountsCache.get(byId);
    if (cached) return cached;
    const counts = buildTotalDescendantCounts(byId);
    totalDescendantCountsCache.set(byId, counts);
    return counts;
}

function getVisibleDescendantCounts(flat = [], byId = {}) {
    if (!Array.isArray(flat)) {
        return buildVisibleDescendantCounts(flat, byId);
    }
    const cached = visibleDescendantCountsCache.get(flat);
    if (cached) return cached;
    const counts = buildVisibleDescendantCounts(flat, byId);
    visibleDescendantCountsCache.set(flat, counts);
    return counts;
}

function getCollapseBadge(sessionId, entry, totalDescendantCounts, visibleDescendantCounts) {
    const totalDescendants = totalDescendantCounts.get(sessionId) || 0;
    const visibleDescendants = visibleDescendantCounts.get(sessionId) || 0;
    const hiddenDescendants = Math.max(0, totalDescendants - visibleDescendants);
    const badgeCount = entry?.collapsed ? totalDescendants : hiddenDescendants;
    if (!badgeCount) return null;
    return { text: `[+${badgeCount}]`, color: "cyan" };
}

function formatCronTimestampForClient(value) {
    if (!value) return "scheduled";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "scheduled";
    try {
        return date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZoneName: "short",
        }).replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();
    } catch {
        return date.toISOString().replace(/\.000Z$/, "Z");
    }
}

function getCronBadge(session) {
    if (session?.cronActive === true && session?.cronKind === "wall-clock") {
        return {
            text: `[cron ${formatCronTimestampForClient(session.cronNextFireAt)}]`,
            color: "magenta",
        };
    }
    if (!(session?.cronActive === true && typeof session?.cronInterval === "number")) {
        return null;
    }
    return {
        text: `[cron ${formatHumanDurationSeconds(session.cronInterval)}]`,
        color: "magenta",
    };
}

function canPinSessionRow(session) {
    return Boolean(
        session
        && !session.isSystem
        && (session.isGroup || (!session.parentSessionId && !session.groupId)),
    );
}

function buildSelectedSessionMetaRuns(session, mode) {
    const runs = [];
    const statusLabel = getSessionRowStatusLabel(session);
    if (statusLabel) {
        runs.push({ text: statusLabel, color: sessionStatusColor(session, mode) });
    }

    const modelLabel = shortModelReasoningLabel(session?.model, session?.reasoningEffort);
    if (modelLabel) {
        if (runs.length > 0) runs.push({ text: " · ", color: "gray" });
        runs.push({ text: modelLabel, color: "cyan" });
    }

    const contextBadge = getContextHeaderBadge(session?.contextUsage);
    if (contextBadge) {
        if (runs.length > 0) runs.push({ text: " · ", color: "gray" });
        runs.push({ text: contextBadge.text, color: contextBadge.color });
    }

    const compactionBadge = getContextCompactionBadge(session?.contextUsage);
    if (compactionBadge) {
        if (runs.length > 0) runs.push({ text: " · ", color: "gray" });
        runs.push({ text: compactionBadge.text, color: compactionBadge.color });
    }

    return runs;
}

function buildSessionRowView(entry, session, state, totalDescendantCounts, visibleDescendantCounts) {
    const prefixRuns = [];
    const mode = state.connection?.mode || "local";
    const depthPrefix = entry.depth > 0
        ? `${"  ".repeat(Math.max(0, entry.depth - 1))}└ `
        : "";

    if (depthPrefix) {
        prefixRuns.push({ text: depthPrefix, color: "gray" });
    }

    const pinnedSet = new Set(Array.isArray(state.sessions?.pinnedIds) ? state.sessions.pinnedIds : []);
    const selectedSet = new Set(Array.isArray(state.sessions?.selectedIds) ? state.sessions.selectedIds : []);
    const selectMode = Boolean(state.sessions?.selectMode);
    const isSelected = selectedSet.has(entry.sessionId);
    const isPinned = pinnedSet.has(entry.sessionId);

    if (selectMode) {
        prefixRuns.push({
            text: isSelected ? "[x] " : "[ ] ",
            color: isSelected ? "cyan" : "gray",
            bold: isSelected,
        });
    }

    // Pin column renders first on top-level non-system rows so pinned and
    // unpinned groups/sessions line up vertically — pinned rows get the 📌
    // glyph, unpinned rows get a width-matched spacer. Children and system
    // rows skip the column, and when NOTHING is pinned the column is omitted
    // entirely: otherwise every user row carries three dead columns and sits
    // visibly indented relative to system rows.
    if (entry.depth === 0 && canPinSessionRow(session) && pinnedSet.size > 0) {
        if (isPinned && !session?.isSystem) {
            prefixRuns.push({ text: "📌 ", color: "yellow" });
        } else {
            // 📌 plus a trailing space measures ~3 cells in a typical
            // monospace terminal/portal; keep the spacer the same width.
            prefixRuns.push({ text: "   ", color: "gray" });
        }
    }

    if (session?.isGroup) {
        prefixRuns.push({ text: "🗂  ", color: "cyan", bold: true });
    } else if (session?.isSystem) {
        prefixRuns.push({ text: "⚙ ", color: "yellow", bold: true });
    } else {
        const icon = sessionStatusIcon(session, mode);
        prefixRuns.push({
            text: icon ? `${icon} ` : "  ",
            color: sessionStatusColor(session, mode),
        });
    }

    const mainColor = session?.isGroup ? "cyan" : session?.isSystem ? "yellow" : sessionStatusColor(session, mode);
    const effectiveOwner = effectiveSessionOwner(session, state.sessions?.byId || {});

    const shortId = shortSessionId(session?.sessionId);

    // Row age — last-updated (the value the list is sorted by). Coarse buckets
    // so it doesn't tick every second: <1min · Nmin · NhMMm · NdHHh · Nw.
    const rowTimestampMs = session?.updatedAt
        || session?.summaryUpdatedAt
        || session?.latestSummaryUpdatedAt
        || session?.createdAt
        || 0;
    const relTime = rowTimestampMs ? formatSessionAge(rowTimestampMs) : "";
    const modelLabel = shortModelReasoningLabel(session?.model, session?.reasoningEffort);

    // A regular session with no human title otherwise renders as a bare
    // "(guid)" — an empty, ugly line. For those, pull the meta (id · age ·
    // model) UP onto the main line so it carries information. Titled rows keep
    // the title on the line and expand id·age·model·ctx only when selected.
    const rawTitle = session?.isSystem
        ? canonicalSystemTitle(session, state.branding?.title || "PilotSwarm")
        : buildSessionDisplayTitle(session);
    const hasRealTitle = Boolean(session?.isSystem || session?.isGroup || (rawTitle && rawTitle.trim()));

    const titleRuns = [...prefixRuns];
    // Owner chip — only when the list actually surfaces more than one human
    // owner (shouldDecorateSessionOwners). Otherwise it's noise on every row.
    if (shouldDecorateSessionOwners(state) && !session?.isSystem && !session?.isGroup) {
        const initials = effectiveOwner ? ownerInitials(effectiveOwner) : "?";
        titleRuns.push({ text: `${initials} · `, color: "cyan" });
    }
    if (hasRealTitle) {
        titleRuns.push({ text: rawTitle, color: mainColor, bold: Boolean(session?.isSystem || session?.isGroup) });
    } else {
        // Untitled → id · age · model on one line (no wasted title line).
        titleRuns.push({ text: shortId, color: mainColor });
        if (relTime) { titleRuns.push({ text: " · ", color: "gray" }); titleRuns.push({ text: relTime, color: "gray" }); }
        if (modelLabel) { titleRuns.push({ text: " · ", color: "gray" }); titleRuns.push({ text: modelLabel, color: "green" }); }
    }

    const collapseBadge = getCollapseBadge(session?.sessionId, entry, totalDescendantCounts, visibleDescendantCounts);
    if (collapseBadge) {
        titleRuns.push({ text: ` ${collapseBadge.text}`, color: collapseBadge.color, bold: collapseBadge.bold });
    }
    // Scheduled sessions keep a compact clock glyph on the title; the full
    // cron cadence rides in the detail line.
    const cronBadge = getCronBadge(session);
    if (cronBadge) {
        titleRuns.push({ text: " ⏱", color: "magenta" });
    }

    // Right-column context %: on every row that has usage. Compaction in
    // flight takes precedence; else green normally, amber ≥70, red ≥85.
    const ctxRuns = [];
    const compactionState = session?.contextUsage?.compaction?.state;
    const ctxPercent = computeContextPercent(session?.contextUsage);
    if (session?.isGroup) {
        if (session?.memberCount != null) ctxRuns.push({ text: `${session.memberCount}`, color: "gray" });
    } else if (compactionState === "running") {
        ctxRuns.push({ text: "⇊", color: "magenta" });
    } else if (compactionState === "failed") {
        ctxRuns.push({ text: "!", color: "red" });
    } else if (ctxPercent != null) {
        ctxRuns.push({ text: `${ctxPercent}%`, color: ctxPercent >= 85 ? "red" : ctxPercent >= 70 ? "yellow" : "green" });
    } else {
        ctxRuns.push({ text: "—", color: "gray" });
    }

    // Kept for backward-compat consumers; groups carry a member/time meta.
    const metaRuns = [];
    if (session?.isGroup && session?.memberCount != null) {
        metaRuns.push({ text: `${session.memberCount} member${session.memberCount === 1 ? "" : "s"}`, color: "gray" });
        if (relTime) { metaRuns.push({ text: " · ", color: "gray" }); metaRuns.push({ text: relTime, color: "gray" }); }
    }

    // Detail — expanded under the SELECTED row. Titled rows repeat
    // id · age · model here; untitled rows already carry those on the main
    // line, so their detail starts at the ctx breakdown to avoid repetition.
    const detailRuns = [];
    const pushSep = () => { if (detailRuns.length) detailRuns.push({ text: " · ", color: "gray" }); };
    if (session?.isGroup) {
        detailRuns.push(...metaRuns);
    } else {
        if (hasRealTitle) {
            detailRuns.push({ text: shortId, color: "cyan" });
            if (relTime) { pushSep(); detailRuns.push({ text: relTime, color: "gray" }); }
            if (modelLabel) { pushSep(); detailRuns.push({ text: modelLabel, color: "green" }); }
        }
        const cu = session?.contextUsage;
        if (cu && Number.isFinite(cu.currentTokens) && Number.isFinite(cu.tokenLimit) && cu.tokenLimit > 0) {
            pushSep();
            detailRuns.push({ text: `ctx ${formatCompactNumber(cu.currentTokens)}/${formatCompactNumber(cu.tokenLimit)}`, color: "gray" });
        }
        const childCount = totalDescendantCounts?.[session?.sessionId];
        if (childCount) { pushSep(); detailRuns.push({ text: `${childCount} child${childCount === 1 ? "" : "ren"}`, color: "gray" }); }
        if (cronBadge) { pushSep(); detailRuns.push({ text: cronBadge.text, color: cronBadge.color }); }
    }

    // Flat runs for the TUI: title + (for titled rows) dim age + context.
    const runs = [
        ...titleRuns,
        ...(hasRealTitle && relTime && !session?.isGroup ? [{ text: "  ", color: "gray" }, { text: relTime, color: "gray" }] : []),
        ...(ctxRuns.length && !session?.isGroup ? [{ text: " · ", color: "gray" }, ...ctxRuns] : []),
        ...(session?.isGroup && metaRuns.length ? [{ text: " ", color: "gray" }, ...metaRuns] : []),
    ];

    return {
        runs,
        titleRuns,
        ctxRuns,
        metaRuns,
        badgeRuns: [],
        selectedMetaRuns: detailRuns,
        detailRuns,
    };
}

function normalizeSearchQuery(value) {
    return String(value || "").trim().toLowerCase();
}

function matchesSearchQuery(value, query) {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return true;
    return String(value || "").toLowerCase().includes(normalizedQuery);
}

export function selectSessionRows(state) {
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(state.sessions.flat, state.sessions.byId);
    const query = normalizeSearchQuery(state.sessions?.filterQuery || "");
    const ownerFilter = state.sessions?.ownerFilter || { all: true };
    const auth = state.auth || {};
    const pinnedSet = new Set(Array.isArray(state.sessions?.pinnedIds) ? state.sessions.pinnedIds : []);
    const selectedSet = new Set(Array.isArray(state.sessions?.selectedIds) ? state.sessions.selectedIds : []);

    return state.sessions.flat.map((entry) => {
        const session = state.sessions.byId[entry.sessionId];
        const rowView = buildSessionRowView(entry, session, state, totalDescendantCounts, visibleDescendantCounts);
        return {
            sessionId: entry.sessionId,
            text: flattenRunsText(rowView.runs),
            ...rowView,
            depth: entry.depth,
            status: session?.status,
            statusColor: sessionStatusColor(session, state.connection?.mode || "local"),
            active: entry.sessionId === state.sessions.activeSessionId,
            isSystem: Boolean(session?.isSystem),
            isGroup: Boolean(session?.isGroup),
            hasChildren: entry.hasChildren,
            collapsed: entry.collapsed,
            pinned: pinnedSet.has(entry.sessionId),
            selected: selectedSet.has(entry.sessionId),
            canPin: canPinSessionRow(session),
        };
    }).filter((row) => {
        const session = state.sessions.byId[row.sessionId];
        if (!matchesOwnerFilter(session, ownerFilter, auth, state.sessions.byId)) return false;
        const effectiveOwner = effectiveSessionOwner(session, state.sessions.byId);
        const ownerSearchText = effectiveOwner
            ? `${ownerDisplayName(effectiveOwner, "")} ${effectiveOwner.email || ""}`
            : "";
        const summarySearchText = `${session?.shortSummary || ""} ${session?.summaryState?.intent || ""} ${session?.summaryState?.summary || ""}`;
        return matchesSearchQuery(row.text, query)
            || matchesSearchQuery(row.sessionId, query)
            || matchesSearchQuery(ownerSearchText, query)
            || matchesSearchQuery(summarySearchText, query);
    });
}

export function selectVisibleSessionRows(state, maxRows = 8) {
    const rows = selectSessionRows(state);
    if (rows.length === 0) return [];

    const filteredSessionIds = new Set(rows.map((row) => row.sessionId));
    const flat = (Array.isArray(state.sessions?.flat) ? state.sessions.flat : [])
        .filter((entry) => filteredSessionIds.has(entry.sessionId));

    const activeIndexRaw = flat.findIndex((entry) => entry.sessionId === state.sessions.activeSessionId);
    const activeIndex = Math.max(0, activeIndexRaw);
    if (flat.length <= maxRows) {
        return rows;
    }

    const half = Math.floor(maxRows / 2);
    let start = Math.max(0, activeIndex - half);
    let end = Math.min(flat.length, start + maxRows);

    if (end > flat.length) {
        end = flat.length;
        start = Math.max(0, end - maxRows);
    }

    const visibleEntries = flat.slice(start, end);
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(flat, state.sessions.byId);

    return rows.filter((row) => visibleEntries.some((entry) => entry.sessionId === row.sessionId));
}

export function selectActiveSession(state) {
    const sessionId = state.sessions.activeSessionId;
    return sessionId ? state.sessions.byId[sessionId] || null : null;
}

/**
 * True when the session row is actively running a turn that Stop can target.
 * Applies to user AND system sessions; group/container rows are not sessions.
 */
export function canStopSessionTurn(session) {
    if (!session || session.isGroup) return false;
    return (session.status || "") === "running";
}

function buildPendingQuestionMessage(session) {
    const pendingQuestion = session?.pendingQuestion;
    if (!pendingQuestion?.question) return null;

    const body = [String(pendingQuestion.question).trim()];
    const choices = Array.isArray(pendingQuestion.choices)
        ? pendingQuestion.choices.filter((choice) => typeof choice === "string" && choice.trim())
        : [];

    if (choices.length > 0) {
        body.push("", "Choices:");
        for (const choice of choices) {
            body.push(`- ${choice}`);
        }
    }

    if (choices.length > 0 && pendingQuestion.allowFreeform === false) {
        body.push("", "Reply with one of the choices above in the prompt below.");
    } else if (choices.length > 0) {
        body.push("", "Reply with one of the choices above, or type a free-form answer below.");
    } else {
        body.push("", "Type your answer in the prompt below and press Enter.");
    }

    return {
        id: `pending-question:${session.sessionId}:${pendingQuestion.question}`,
        role: "system",
        text: body.join("\n"),
        time: "",
        createdAt: session.updatedAt || Date.now(),
        cardTitle: "Question",
        cardTitleColor: "cyan",
        cardBorderColor: "cyan",
    };
}

function buildAnsweredPendingQuestionMessage(session, chat = []) {
    const answeredQuestion = session?.answeredPendingQuestion;
    const question = String(answeredQuestion?.question || "").trim();
    const answer = String(answeredQuestion?.answer || "").trim();
    if (!question || !answer) return null;
    if (chatAlreadyContainsPendingQuestion(chat, question)) return null;

    const pendingPhase = answeredQuestion.pendingPhase === "queued" ? "queued" : "pending";
    const createdAt = Number(answeredQuestion.answeredAt || 0) || session.updatedAt || Date.now();
    return {
        id: `answered-question:${session.sessionId}:${question}:${createdAt}`,
        role: "user",
        text: `The user was asked: "${question}"\nThe user responded: "${answer}"`,
        time: "",
        createdAt,
        optimistic: true,
        pendingPhase,
    };
}

function buildPendingOutboxMessage(sessionId, item) {
    if (!sessionId || !item?.id) return null;
    const text = String(item.text || "").trim();
    if (!text) return null;
    return {
        id: `pending-outbox:${sessionId}:${item.id}`,
        role: "user",
        text,
        time: "",
        createdAt: Number(item.createdAt) || Date.now(),
        pendingPhase: item.phase === "cancelling"
            ? "cancelling"
            : item.phase === "queued"
                ? "queued"
                : "pending",
    };
}

function chatAlreadyContainsPendingQuestion(chat, question) {
    const normalizedQuestion = String(question || "").trim();
    if (!normalizedQuestion) return false;

    return (chat || []).some((message) => {
        const parsedExchange = parseAskedAndAnsweredExchange(message?.text || "");
        if (parsedExchange?.question?.trim() === normalizedQuestion) return true;
        return false;
    });
}

function buildSessionErrorMessage(session) {
    const errorText = String(session?.error || "").trim();
    if (!errorText) return null;

    const errorKind = getSessionErrorVisualKind(session);
    if (!errorKind) return null;

    const isFailed = errorKind === "failed";
    const body = isFailed
        ? errorText
        : `${errorText}\n\nThe orchestration is still running, so this may be transient.`;

    return {
        id: `session-error:${session.sessionId}:${errorKind}:${errorText}`,
        role: "system",
        text: body,
        time: "",
        createdAt: session.updatedAt || Date.now(),
        cardTitle: isFailed ? "Error" : "Warning",
        cardTitleColor: isFailed ? "red" : "yellow",
        cardBorderColor: isFailed ? "red" : "yellow",
    };
}

function latestEventSeq(events = [], eventType) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.eventType === eventType) {
            return Number(event?.seq || 0);
        }
    }
    return 0;
}

function summarizeProgressActivityText(text) {
    const normalized = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return "";

    return normalized
        .replace(/^\[[^\]]+\]\s*/, "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .trim();
}

function pickLatestProgressActivity(history, floorSeq = 0) {
    const activity = Array.isArray(history?.activity) ? history.activity : [];
    const ignoredTypes = new Set([
        "assistant.reasoning",
        "assistant.turn_start",
        "session.turn_started",
        "session.turn_completed",
    ]);

    for (let index = activity.length - 1; index >= 0; index -= 1) {
        const item = activity[index];
        if (!item || ignoredTypes.has(item.eventType)) continue;
        if (Number(item?.seq || 0) <= floorSeq) continue;
        const text = summarizeProgressActivityText(item.text);
        if (!text) continue;
        return {
            ...item,
            summaryText: text,
        };
    }

    return null;
}

function buildLiveProgressState(session, history, chat = [], outboxItems = []) {
    if (!session || session?.pendingQuestion?.question) return null;

    const status = String(session?.status || "").toLowerCase();
    if (status === "completed" || status === "failed" || status === "cancelled") {
        return null;
    }

    const visibleChat = (chat || []).filter((message) => message?.role === "user" || message?.role === "assistant");
    const lastVisibleMessage = visibleChat[visibleChat.length - 1] || null;
    const waitingOnAssistantFromChat = lastVisibleMessage?.role === "user";
    const optimisticUserPending = waitingOnAssistantFromChat && lastVisibleMessage?.optimistic === true;
    const pendingOutboxCount = (outboxItems || []).filter((item) => item?.phase === "pending").length;
    const queuedOutboxCount = (outboxItems || []).filter((item) => item?.phase === "queued").length;
    const cancellingOutboxCount = (outboxItems || []).filter((item) => item?.phase === "cancelling").length;

    const events = Array.isArray(history?.events) ? history.events : [];
    const lastUserSeq = latestEventSeq(events, "user.message");
    const lastAssistantSeq = latestEventSeq(events, "assistant.message");
    const waitingOnAssistantFromEvents = lastUserSeq > lastAssistantSeq;
    if (status === "waiting" || status === "input_required") {
        return null;
    }
    if (!waitingOnAssistantFromChat && !waitingOnAssistantFromEvents && status !== "running" && !optimisticUserPending) {
        return null;
    }

    const floorSeq = Math.max(lastUserSeq, lastAssistantSeq);
    const reasoningEvents = events.filter((event) => (
        event?.eventType === "assistant.reasoning"
        && Number(event?.seq || 0) > floorSeq
    ));
    const latestReasoning = reasoningEvents[reasoningEvents.length - 1] || null;
    const reasoningText = String(
        latestReasoning?.data?.content
        || latestReasoning?.data?.text
        || latestReasoning?.data?.message
        || "",
    ).trim();
    if (reasoningText) {
        return {
            kind: "thinking",
            label: "Thinking",
            text: reasoningText,
            createdAt: latestReasoning?.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: latestReasoning?.seq || 0,
        };
    }

    const latestActivity = pickLatestProgressActivity(history, floorSeq);
    if (latestActivity?.summaryText) {
        return {
            kind: status === "running" ? "working" : "sending",
            label: status === "running" ? "Working" : "Sending",
            text: latestActivity.summaryText,
            createdAt: latestActivity.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: latestActivity.seq || 0,
        };
    }

    if (pendingOutboxCount > 0) {
        return {
            kind: "pending",
            label: pendingOutboxCount === 1 ? "Pending" : `Pending ${pendingOutboxCount}`,
            text: pendingOutboxCount === 1 ? "One prompt is waiting to be sent." : `${pendingOutboxCount} prompts are waiting to be sent.`,
            createdAt: outboxItems[outboxItems.length - 1]?.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: 0,
        };
    }

    if (queuedOutboxCount > 0) {
        return {
            kind: "queued",
            label: queuedOutboxCount === 1 ? "Queued" : `Queued ${queuedOutboxCount}`,
            text: queuedOutboxCount === 1 ? "One prompt is durably queued, waiting for the LLM to receive it." : `${queuedOutboxCount} prompts are durably queued, waiting for the LLM to receive them.`,
            createdAt: outboxItems[outboxItems.length - 1]?.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: 0,
        };
    }

    if (cancellingOutboxCount > 0) {
        return {
            kind: "cancelling",
            label: cancellingOutboxCount === 1 ? "Cancelling" : `Cancelling ${cancellingOutboxCount}`,
            text: cancellingOutboxCount === 1 ? "One queued prompt is waiting for cancellation confirmation." : `${cancellingOutboxCount} queued prompts are waiting for cancellation confirmation.`,
            createdAt: outboxItems[outboxItems.length - 1]?.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: 0,
        };
    }

    if (optimisticUserPending) {
        return {
            kind: "sending",
            label: "Sending",
            text: "Working on it...",
            createdAt: lastVisibleMessage?.createdAt || session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: 0,
        };
    }

    if (status === "running") {
        return {
            kind: "working",
            label: "Working",
            text: "Working on it...",
            createdAt: session.updatedAt || Date.now(),
            lastUserSeq,
            lastAssistantSeq,
            tokenSeq: 0,
        };
    }

    return null;
}

export function selectActiveChat(state) {
    const sessionId = state.sessions.activeSessionId;
    const session = sessionId ? state.sessions.byId[sessionId] || null : null;
    if (!sessionId) return createSplashCard(state.branding);
    if (session?.isGroup) {
        const memberSessions = Object.values(state.sessions.byId || {})
            .filter((candidate) => candidate && !candidate.isGroup && candidate.groupId === session.groupId && !candidate.parentSessionId);
        const markdownCell = (value) => String(value ?? "")
            .replace(/\|/g, "\\|")
            .replace(/[\r\n]+/g, " ")
            .trim() || " ";
        const memberRows = memberSessions.map((candidate) => (
            `| ${markdownCell(candidate.title || candidate.sessionId)} | ${markdownCell(candidate.status || "unknown")} | ${markdownCell(candidate.shortSummary || "")} |`
        ));
        const lines = [
            `# ${session.title || session.groupId}`,
            session.shortSummary || "",
            "",
            "| Metric | Count |",
            "|---|---:|",
            `| Members | ${session.memberCount ?? memberSessions.length} |`,
            `| Running | ${session.runningCount ?? 0} |`,
            `| Waiting | ${session.waitingCount ?? 0} |`,
            `| Completed | ${session.completedCount ?? 0} |`,
            `| Failed | ${session.failedCount ?? 0} |`,
            `| Cancelled | ${session.cancelledCount ?? 0} |`,
            "",
            "## Members",
            ...(memberRows.length > 0
                ? [
                    "| Session | Status | Summary |",
                    "|---|---|---|",
                    ...memberRows,
                ]
                : ["_No top-level members._"]),
        ];
        return [{
            id: `group-details:${session.sessionId}`,
            role: "system",
            noChrome: true,
            text: lines.filter((line, index) => index === 1 || String(line || "").length > 0).join("\n"),
            createdAt: session.updatedAt || Date.now(),
        }];
    }
    if (state.ui?.chatViewMode === "summary") {
        return buildSessionSummaryCards(session);
    }
    const history = state.history.bySessionId.get(sessionId);
    const chat = history?.chat || [];
    const pendingQuestionMessage = session?.pendingQuestion?.question
        && !chatAlreadyContainsPendingQuestion(chat, session.pendingQuestion.question)
        ? buildPendingQuestionMessage(session)
        : null;
    const answeredQuestionMessage = buildAnsweredPendingQuestionMessage(session, chat);
    const sessionErrorMessage = buildSessionErrorMessage(session);

    if ((!history || chat.length === 0) && !pendingQuestionMessage && !answeredQuestionMessage && !sessionErrorMessage) {
        return createSplashCard(state.branding, session);
    }

    const messages = chat.length > 0 ? [...chat] : createSplashCard(state.branding, session);
    if (pendingQuestionMessage) {
        messages.push(pendingQuestionMessage);
    }
    if (answeredQuestionMessage) {
        messages.push(answeredQuestionMessage);
    }
    if (sessionErrorMessage) {
        messages.push(sessionErrorMessage);
    }
    return messages;
}

function buildSessionSummaryCards(session) {
    const normalizeSummaryMarkdownText = (value) => {
        const source = String(value || "");
        if (!source.includes("\\n")) return source;
        return source
            .replace(/\\\\n/g, "\n")
            .replace(/\\n/g, "\n");
    };

    const summaryState = session?.summaryState && typeof session.summaryState === "object" && !Array.isArray(session.summaryState)
        ? session.summaryState
        : null;
    const stateJson = summaryState?.state && typeof summaryState.state === "object" && !Array.isArray(summaryState.state)
        ? summaryState.state
        : null;
    const title = buildSessionDisplayTitle(session) || session?.title || session?.sessionId || "Session";
    const lines = [];
    lines.push(`# ${title}`);
    lines.push("");

    // Compact metadata header — status / intent / updated on their own
    // lines, each as a bold-labeled value. Skipped when empty.
    const metaPairs = [];
    const statusLabel = getSessionSummaryStatusLabel(session);
    if (statusLabel) metaPairs.push(["Status", statusLabel]);
    if (summaryState?.intent) metaPairs.push(["Intent", String(summaryState.intent)]);
    if (session?.summaryUpdatedAt) {
        const ts = formatTimestamp(session.summaryUpdatedAt);
        if (ts) metaPairs.push(["Updated", ts]);
    }
    for (const [label, value] of metaPairs) {
        lines.push(`**${label}:** ${value}`);
    }
    if (metaPairs.length > 0) lines.push("");

    // Free-form summary paragraph (uses the LLM-authored summary if present,
    // otherwise the short summary the CLI rolls up).
    const narrative = normalizeSummaryMarkdownText(summaryState?.summary || session?.shortSummary || "").trim();
    if (narrative) {
        lines.push(narrative);
        lines.push("");
    }

    // Structured state — each key:value renders as a bold-labeled bullet.
    // Lists/objects are rendered as nested bullets so arrays of "progress"
    // steps don't appear as JSON blobs.
    if (stateJson) {
        const entries = Object.entries(stateJson)
            .filter(([, value]) => value !== null && value !== undefined && !(typeof value === "string" && !value.trim()));
        if (entries.length > 0) {
            lines.push("## State");
            for (const [key, value] of entries) {
                if (Array.isArray(value)) {
                    if (value.length === 0) {
                        lines.push(`- **${key}:** _(empty)_`);
                    } else {
                        lines.push(`- **${key}:**`);
                        for (const item of value.slice(0, 16)) {
                            const text = typeof item === "string"
                                ? normalizeSummaryMarkdownText(item)
                                : JSON.stringify(item);
                            lines.push(`  - ${text}`);
                        }
                    }
                } else if (value && typeof value === "object") {
                    lines.push(`- **${key}:**`);
                    for (const [subKey, subValue] of Object.entries(value).slice(0, 16)) {
                        const text = typeof subValue === "string"
                            ? normalizeSummaryMarkdownText(subValue)
                            : JSON.stringify(subValue);
                        lines.push(`  - **${subKey}:** ${text}`);
                    }
                } else {
                    lines.push(`- **${key}:** ${normalizeSummaryMarkdownText(String(value))}`);
                }
            }
            lines.push("");
        }
    }

    // Structured tail sections. Each section renders only if it actually
    // has items; skipped sections do not occupy vertical space.
    for (const [heading, field] of [["Blockers", "blockers"], ["Open Questions", "openQuestions"], ["Next Actions", "nextActions"]]) {
        const items = Array.isArray(summaryState?.[field]) ? summaryState[field].filter(Boolean).slice(0, 12) : [];
        if (items.length === 0) continue;
        lines.push(`## ${heading}`);
        for (const item of items) {
            lines.push(`- ${typeof item === "string" ? normalizeSummaryMarkdownText(item) : JSON.stringify(item)}`);
        }
        lines.push("");
    }

    if (!summaryState && !narrative) {
        lines.push("_No summary has been written yet for this session._");
    }

    // Collapse trailing blank lines so the pane doesn't render empty rows
    // at the bottom.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    return [{
        id: `summary:${session?.sessionId || "none"}`,
        role: "system",
        noChrome: true,
        text: lines.join("\n"),
        createdAt: session?.summaryUpdatedAt || session?.updatedAt || Date.now(),
    }];
}

export function selectActiveOutboxMessages(state) {
    const sessionId = state.sessions.activeSessionId;
    if (!sessionId) return [];
    return Array.isArray(state.outbox?.bySessionId?.[sessionId])
        ? state.outbox.bySessionId[sessionId].map((item) => buildPendingOutboxMessage(sessionId, item)).filter(Boolean)
        : [];
}

function prefixRuns(text, color = "gray", options = {}) {
    return [{
        text,
        color,
        bold: Boolean(options.bold),
        underline: Boolean(options.underline),
    }];
}

function buildChatMessagePrefix(message) {
    const time = formatTimestamp(message?.createdAt || message?.time);
    const roleLabel = message?.role === "user"
        ? "You"
        : message?.role === "assistant"
            ? "Agent"
            : message?.role === "system"
                ? "System"
                : "PilotSwarm";

    // 3-state delivery glyph for user messages:
    //   ○   pending  — client outbox, not yet durable
    //   ✓   queued   — durably enqueued, waiting for orchestration to drain
    //   x   cancelling — durable cancel requested, waiting for runtime outcome
    //   ✓✓  sent     — persisted as user.message in CMS, LLM has it
    let glyph = null;
    let glyphColor = null;
    if (message?.pendingPhase === "pending") {
        glyph = "○";
        glyphColor = "yellow";
    } else if (message?.pendingPhase === "queued") {
        glyph = "✓";
        glyphColor = "cyan";
    } else if (message?.pendingPhase === "cancelling") {
        glyph = "x";
        glyphColor = "red";
    } else if (message?.role === "user" && !message?.optimistic && !message?.pendingPhase) {
        if (message?.stopped) {
            // Delivered, but its turn was user-stopped mid-flight — the model
            // may not have acted on it. Amber prohibition ("no parking") sign.
            glyph = "⊘";
            glyphColor = "yellow";
        } else {
            // Real durable user.message in transcript — show the "sent" double-check.
            glyph = "✓✓";
            glyphColor = "green";
        }
    }

    const roleColor = message?.pendingPhase === "pending"
        ? "yellow"
        : message?.pendingPhase === "queued"
            ? "cyan"
            : message?.pendingPhase === "cancelling"
                ? "red"
            : message?.role === "user"
                ? USER_CHAT_LABEL_COLOR
        : message?.role === "assistant"
            ? "green"
            : message?.role === "system"
                ? "yellow"
                : "white";
    const prefix = time ? `[${time}] ` : "";
    const runs = [...prefixRuns(prefix, "gray")];
    if (glyph) {
        runs.push(...prefixRuns(`${glyph} `, glyphColor));
    }
    runs.push(...prefixRuns(`${roleLabel}: `, roleColor, { bold: true }));
    return runs;
}

function flattenLineText(lineRuns) {
    if (!Array.isArray(lineRuns)) {
        // Sentinel block-shaped lines (e.g. { kind: "markdownTable" }) have
        // no flat text but are NOT blank — surface a placeholder so callers
        // like trimLeadingBlankLines and the chat-spacer logic treat them
        // as content rather than padding.
        if (lineRuns?.kind === "markdownTable") return "[table]";
        return String(lineRuns?.text || "");
    }
    return (lineRuns || []).map((run) => run?.text || "").join("");
}

function createBlankLine() {
    return [{ text: "", color: null }];
}

function startsWithStructuredBlock(lines) {
    const firstVisibleLine = (lines || []).find((line) => flattenLineText(line).trim().length > 0);
    if (firstVisibleLine?.kind === "markdownTable") return true;
    const text = flattenLineText(firstVisibleLine).trimStart();
    return /^[┌│└]/.test(text);
}

function trimLeadingBlankLines(lines) {
    const source = Array.isArray(lines) ? [...lines] : [];
    while (source.length > 0) {
        const firstLine = source[0];
        if (flattenLineText(firstLine).trim().length > 0) break;
        source.shift();
    }
    return source;
}

function extractWrappedSystemNotice(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    const trimmed = normalized.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("[SYSTEM:") && trimmed.endsWith("]")) {
        return {
            leadingText: "",
            systemText: trimmed.slice("[SYSTEM:".length, -1).trim(),
        };
    }

    const marker = normalized.lastIndexOf("\n\n[SYSTEM:");
    if (marker >= 0 && normalized.trimEnd().endsWith("]")) {
        const leadingText = normalized.slice(0, marker).trimEnd();
        const systemBlock = normalized.slice(marker + 2).trim();
        if (systemBlock.startsWith("[SYSTEM:")) {
            return {
                leadingText,
                systemText: systemBlock.slice("[SYSTEM:".length, -1).trim(),
            };
        }
    }

    // The orchestration's queueFollowup() strips the [SYSTEM: ...] wrapper
    // before persisting tool-result followups (sub-agent completions, agent
    // listings, etc.) so the LLM doesn't loop on a synthetic system prompt.
    // The bare text still describes a system notice — match the known
    // followup shapes here so the renderer can surface them as cards
    // instead of as raw "You: …" bubbles.
    if (BARE_SYSTEM_NOTICE_PATTERN.test(trimmed)) {
        return { leadingText: "", systemText: trimmed };
    }

    return null;
}

// Bare followup shapes produced by orchestration.ts queueFollowup() after
// the [SYSTEM: …] wrapper has been stripped. Keep this aligned with the
// `queueFollowup(...)` call sites in orchestration.ts.
const BARE_SYSTEM_NOTICE_PATTERN = /^(?:Sub-agents?\s+completed\b|Sub-agent\s+status\s+report\b|Active\s+sessions\b|No\s+(?:tracked\s+sub-agents|running\s+sub-agents|sub-agents\s+have\s+been\s+spawned)\b|spawn_agent\s+failed\b|message_agent\s+failed\b|complete_agent\s+failed\b)/i;

function splitSystemNoticeSegments(text) {
    const wrapped = extractWrappedSystemNotice(text);
    if (wrapped) {
        const segments = [];
        if (wrapped.leadingText) {
            segments.push({
                kind: "text",
                text: wrapped.leadingText,
            });
        }
        const strippedWrappedSystemText = stripLeadingRehydrationNoticeText(wrapped.systemText);
        if (strippedWrappedSystemText) {
            segments.push({
                kind: "system",
                text: strippedWrappedSystemText,
            });
        }
        return segments;
    }

    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const segments = [];
    let textLines = [];

    function flushText() {
        if (textLines.length === 0) return;
        segments.push({
            kind: "text",
            text: textLines.join("\n"),
        });
        textLines = [];
    }

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!/^\s*\[SYSTEM:/i.test(line)) {
            textLines.push(line);
            index += 1;
            continue;
        }

        const singleLineMatch = /^\s*\[SYSTEM:\s*(.*?)\]\s*$/i.exec(line);
        if (singleLineMatch) {
            flushText();
            const systemText = stripLeadingRehydrationNoticeText(singleLineMatch[1].trim());
            if (!systemText) {
                index += 1;
                continue;
            }
            segments.push({
                kind: "system",
                text: systemText,
            });
            index += 1;
            continue;
        }

        const noticeLines = [line.replace(/^\s*\[SYSTEM:\s*/i, "")];
        let closingIndex = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const closingLine = lines[cursor];
            if (closingLine.trim() === "]") {
                closingIndex = cursor;
                break;
            }

            if (/\]\s*$/.test(closingLine.trim())) {
                const closingContent = closingLine.replace(/\]\s*$/, "");
                if (closingContent.trim()) {
                    noticeLines.push(closingContent);
                }
                closingIndex = cursor;
                break;
            }

            noticeLines.push(closingLine);
        }

        if (closingIndex === -1) {
            textLines.push(line);
            index += 1;
            continue;
        }

        flushText();
        const systemText = stripLeadingRehydrationNoticeText(noticeLines.join("\n").trim());
        if (!systemText) {
            index = closingIndex + 1;
            continue;
        }
        segments.push({
            kind: "system",
            text: systemText,
        });
        index = closingIndex + 1;
    }

    flushText();
    return segments;
}

function messageHasSystemNotice(message) {
    if (!message) return false;
    if (message?.role === "system") {
        return !isRehydrationNoticeText(message?.text || "")
            || Boolean(stripLeadingRehydrationNoticeText(message?.text || ""));
    }
    if (message?.role !== "user" && message?.role !== "assistant") return false;
    return splitSystemNoticeSegments(message?.text || "").some((segment) => segment.kind === "system");
}

function chatMessageSpacingKind(message) {
    if (messageHasSystemNotice(message)) return "system";
    return message?.role || "other";
}

function shouldInsertChatSpacer(currentMessage, nextMessage) {
    if (!currentMessage || !nextMessage) return false;
    return chatMessageSpacingKind(currentMessage) !== chatMessageSpacingKind(nextMessage);
}

function summarizeSystemNoticeText(text) {
    const normalized = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return "System notice.";
    const rehydratedMatch = /^The session was dehydrated and has been rehydrated on a new worker(?: \(([^)]+)\))?\./.exec(normalized);
    if (rehydratedMatch) {
        return rehydratedMatch[1]
            ? `Session rehydrated on a new worker (${rehydratedMatch[1]}).`
            : "Session rehydrated on a new worker.";
    }

    const sentenceMatch = /^(.{1,160}?[.!?])(?:\s|$)/.exec(normalized);
    const firstSentence = sentenceMatch?.[1]?.trim() || normalized;
    if (firstSentence.length >= normalized.length) {
        return firstSentence.length > 160
            ? `${firstSentence.slice(0, 159).trimEnd()}…`
            : firstSentence;
    }
    return `${firstSentence}…`;
}

function buildCollapsedSystemNoticeLine(text, timestamp = "") {
    const summary = summarizeSystemNoticeText(text);
    return {
        kind: "systemNotice",
        text: `${timestamp ? `[${timestamp}] ` : ""}System: ${summary}`,
        summary,
        body: decorateArtifactLinksForChat(text),
        color: "gray",
    };
}

function buildSystemNoticeLine({ title, summary, body, timestamp = "", color = "gray" }) {
    const normalizedTitle = String(title || "System").trim() || "System";
    const normalizedSummary = String(summary || "").replace(/\s+/g, " ").trim();
    return {
        kind: "systemNotice",
        text: `${timestamp ? `[${timestamp}] ` : ""}${normalizedTitle}${normalizedSummary ? `: ${normalizedSummary}` : ""}`,
        summary: normalizedSummary,
        body: decorateArtifactLinksForChat(body || normalizedSummary),
        color,
    };
}

function buildChatProgressTitleRuns(progress) {
    if (!progress?.label) return null;
    return [{
        text: progress.label,
        color: progress.kind === "working" ? "yellow" : "cyan",
        bold: true,
    }];
}

function tintRunsIfUnset(lines, color) {
    if (!color) return lines;
    return (lines || []).map((lineRuns) => {
        // Block-shaped sentinel lines (e.g. { kind: "markdownTable" }) carry
        // their own per-cell rendering and don't have a flat run array to tint.
        if (!Array.isArray(lineRuns)) return lineRuns;
        return lineRuns.map((run) => ({
            ...run,
            color: run?.color || color,
        }));
    });
}

function startsWithCardBlock(lines) {
    const firstVisibleLine = (lines || []).find((line) => flattenLineText(line).trim().length > 0);
    if (!firstVisibleLine) return false;
    return flattenLineText(firstVisibleLine).trimStart().startsWith("┌");
}

function appendChatBlockLines(targetLines, nextLines) {
    if (!Array.isArray(nextLines) || nextLines.length === 0) return;
    if (
        targetLines.length > 0
        && startsWithCardBlock(nextLines)
        && flattenLineText(targetLines[targetLines.length - 1]).trim().length > 0
    ) {
        targetLines.push([{ text: "", color: null }]);
    }
    targetLines.push(...nextLines);
}

/**
 * Parse the orchestration's `[SYSTEM: Sub-agent(s) completed …]` follow-up
 * prompt into structured per-agent entries. Returns null if `systemText`
 * is not a sub-agent completion notice.
 *
 * Single-agent format (built by `buildWaitForAgentsFollowup` in the
 * orchestration): `Sub-agent completed. <relay instructions>\n  - Agent
 * <orchId>\n    Task: "<task>"\n    Status: <status>\n    Result: <body>`.
 *
 * Multi-agent format: `Sub-agents completed:\n  - Agent <id>\n    Task:
 * "..."\n    ...` repeated per child.
 */
function parseSubAgentNotice(systemText) {
    const text = String(systemText || "");
    const isSingle = /^\s*Sub-agent\s+completed\b/i.test(text);
    const isMulti = /^\s*Sub-agents\s+completed/i.test(text);
    if (!isSingle && !isMulti) return null;
    const agents = [];
    const entryRegex = /(?:^|\n)\s*-\s*Agent\s+(\S+)\s*\n\s*Task:\s*"([^"]*)"\s*\n\s*Status:\s*(\S+)\s*\n\s*Result:\s*([\s\S]*?)(?=(?:\n\s*-\s*Agent\s+\S+)|$)/g;
    let m;
    while ((m = entryRegex.exec(text)) !== null) {
        agents.push({
            agentId: m[1],
            task: m[2],
            status: m[3],
            result: m[4].trim(),
        });
    }
    if (agents.length === 0) return null;
    if (isSingle || agents.length === 1) {
        return { kind: "subAgentSingle", ...agents[0] };
    }
    return { kind: "subAgentMulti", agents };
}

/**
 * Render an in-message `[SYSTEM: …]` notice as a bordered card. When the
 * notice is a sub-agent completion (`Sub-agent completed`/`Sub-agents
 * completed`), parse it into per-child sections and title the card
 * "Sub-agent Response". Otherwise fall back to a plain "System" card.
 */
function buildSystemNoticeCardLines(systemText, message, maxWidth) {
    const safeWidth = Math.max(20, Number(maxWidth) || 20);
    const timestamp = formatTimestamp(message?.createdAt || message?.time);
    const subAgent = parseSubAgentNotice(systemText);
    // Strip the orchestration's `session-` prefix when present so the
    // displayed short id surfaces the unique uuid suffix instead of a
    // useless "session-" stub.
    const shortAgentId = (id) => {
        const raw = String(id || "").replace(/^session-/i, "");
        return shortSessionId(raw) || raw || String(id || "");
    };
    if (subAgent?.kind === "subAgentSingle") {
        const shortId = shortAgentId(subAgent.agentId);
        const body = [
            subAgent.task ? `**Task:** ${subAgent.task}` : "",
            subAgent.status ? `**Status:** ${subAgent.status}` : "",
            "",
            subAgent.result || "_(no result)_",
        ].filter((line, index) => index === 2 || line).join("\n");
        return [buildSystemNoticeLine({
            title: `Sub-agent Response — ${shortId}`,
            summary: subAgent.status || "completed",
            timestamp,
            body,
            color: "cyan",
        })];
    }
    if (subAgent?.kind === "subAgentMulti") {
        const sections = subAgent.agents.map((agent) => {
            const shortId = shortAgentId(agent.agentId);
            const taskLine = agent.task ? `**Task:** ${agent.task}` : "";
            const statusLine = agent.status ? `**Status:** ${agent.status}` : "";
            const header = [`### ${shortId}`, taskLine, statusLine].filter(Boolean).join("\n");
            return `${header}\n\n${agent.result || "_(no result)_"}`;
        });
        const summary = subAgent.agents
            .map((agent) => `${shortAgentId(agent.agentId)} ${agent.status || "completed"}`)
            .join(" · ");
        return [buildSystemNoticeLine({
            title: `Sub-agent Responses (${subAgent.agents.length})`,
            summary,
            timestamp,
            body: sections.join("\n\n---\n\n"),
            color: "cyan",
        })];
    }
    return buildMessageCardLines({
        title: "System",
        timestamp,
        body: systemText,
        width: safeWidth,
        titleColor: "yellow",
        borderColor: "gray",
        bodyColor: "gray",
        fitToContent: true,
    });
}

function buildThinkingCardLines(message, maxWidth) {
    const safeWidth = Math.max(12, Math.min(72, Number(maxWidth) || 12));
    const contentWidth = Math.max(1, safeWidth - 4);
    const timestamp = formatTimestamp(message?.createdAt || message?.time);
    const label = String(message?.thinkingLabel || "Thinking…").trim() || "Thinking…";
    const accentColor = message?.progressKind === "working"
        ? "yellow"
        : message?.progressKind === "sending"
            ? "cyan"
            : "cyan";
    const titleRuns = fitRuns([
        { text: ` ⠋ ${label} `, color: accentColor, bold: true },
        ...(timestamp ? [{ text: ` ${timestamp} `, color: "gray" }] : []),
    ], Math.max(1, safeWidth - 3));
    const titleWidth = titleRuns.reduce((sum, run) => sum + String(run?.text || "").length, 0);
    const topFill = Math.max(0, safeWidth - titleWidth - 3);
    const bodyLines = String(message?.text || "").trim()
        ? trimLeadingBlankLines(parseMarkdownLines(
            decorateArtifactLinksForChat(message.text),
            { width: contentWidth },
        )).flatMap((lineRuns) => wrapRunsToDisplayWidth(lineRuns, contentWidth))
        : [];

    const lines = [[
        { text: "┌─", color: "gray" },
        ...titleRuns,
        { text: `${"─".repeat(topFill)}┐`, color: "gray" },
    ]];

    for (const lineRuns of bodyLines) {
        lines.push([
            { text: "│ ", color: "gray" },
            ...padRunsToDisplayWidth(lineRuns.map((run) => ({
                ...run,
                color: run?.color && run.color !== "white" ? run.color : "gray",
            })), contentWidth),
            { text: " │", color: "gray" },
        ]);
    }

    lines.push([{ text: `└${"─".repeat(Math.max(1, safeWidth - 2))}┘`, color: "gray" }]);
    lines.push([{ text: "", color: null }]);
    return lines;
}

function splashArtWidth(text) {
    return String(text || "")
        .split("\n")
        .reduce((widest, line) => Math.max(widest, stripTerminalMarkupTags(line).length), 0);
}

function buildChatMessageLines(message, maxWidth, options = {}) {
    if (message?.splash) {
        // Swap in the narrow-viewport variant when the main art would
        // overflow the pane (mobile portal, narrow terminals). When the
        // width metrics keep the desktop art, still hand renderers the
        // mobile variant (splashAlt) so environments with real media
        // queries (the browser) can make the final call by CSS viewport —
        // character metrics and device width can disagree.
        const useMobile = message.mobileText && splashArtWidth(message.text) > maxWidth;
        return [{
            kind: "markup",
            value: useMobile ? message.mobileText : message.text,
            splashAlt: !useMobile && message.mobileText ? message.mobileText : null,
        }];
    }

    if (message?.thinking) {
        return buildThinkingCardLines(message, maxWidth);
    }

    // Chrome-less message: render the text as plain markdown directly into
    // the chat pane (no card border, no speaker prefix, no timestamp). Used
    // for the session summary view so the summary feels like the pane's
    // content rather than a single bordered card.
    if (message?.noChrome) {
        const markdownLines = trimLeadingBlankLines(parseMarkdownLines(
            decorateArtifactLinksForChat(message?.text || ""),
            { width: Math.max(20, maxWidth), tableMode: options.tableMode },
        ));
        return markdownLines;
    }

    if (message?.role === "user") {
        const askedAndAnswered = parseAskedAndAnsweredExchange(message?.text || "");
        if (askedAndAnswered) {
            return [
                ...buildMessageCardLines({
                    title: "Question",
                    timestamp: formatTimestamp(message?.createdAt || message?.time),
                    body: askedAndAnswered.question,
                    width: Math.max(20, maxWidth),
                    titleColor: USER_CHAT_COLOR,
                    borderColor: USER_CHAT_COLOR,
                }),
                ...buildChatMessageLines({
                    ...message,
                    text: askedAndAnswered.answer,
                }, maxWidth, options),
            ];
        }
    }

    if (options.allowLeadingSystemNotices !== false && (message?.role === "user" || message?.role === "assistant")) {
        const segments = splitSystemNoticeSegments(message?.text || "");
        if (segments.some((segment) => segment.kind === "system")) {
            const rendered = [];
            let renderedSpeakerText = false;
            for (const segment of segments) {
                if (segment.kind === "system") continue;
                if (!segment.text.trim()) continue;
                appendChatBlockLines(rendered, buildChatMessageLines({
                    ...message,
                    text: segment.text,
                }, maxWidth, {
                    ...options,
                    allowLeadingSystemNotices: false,
                    skipPrefix: renderedSpeakerText,
                }));
                renderedSpeakerText = true;
            }

            if (rendered.length > 0) {
                return rendered;
            }

            // No speaker-visible text remained after stripping the system
            // notices. Render the notice itself as a card so the message
            // doesn't fall through to a raw "You: [SYSTEM: …]" bubble.
            // Sub-agent completion notices get a dedicated card title.
            const cardLines = [];
            for (const segment of segments) {
                if (segment.kind !== "system" || !segment.text.trim()) continue;
                appendChatBlockLines(
                    cardLines,
                    buildSystemNoticeCardLines(segment.text, message, maxWidth),
                );
            }
            if (cardLines.length > 0) {
                return cardLines;
            }
        }
    }

    if (message?.role !== "user" && message?.role !== "assistant") {
        const strippedSystemText = stripLeadingRehydrationNoticeText(message?.text || "");
        if (message?.role === "system" && !strippedSystemText) {
            return [];
        }
        // System-role messages that carry an explicit non-"System" cardTitle
        // (e.g. "Question", "Error", "Warning") are real product cards built by
        // selectors like buildPendingQuestionMessage / buildSessionErrorMessage.
        // Render them as full cards instead of collapsing into a one-line
        // System: notice.
        const hasExplicitCardTitle = Boolean(message?.cardTitle)
            && String(message.cardTitle).toLowerCase() !== "system";
        if (message?.role === "system" && !hasExplicitCardTitle) {
            return [buildCollapsedSystemNoticeLine(
                strippedSystemText || message?.text || "",
                formatTimestamp(message?.createdAt || message?.time),
            )];
        }
        const isSystemCard = message?.role === "system"
            && (!message?.cardTitle || String(message.cardTitle).toLowerCase() === "system");
        return buildMessageCardLines({
            title: message?.cardTitle || (message?.role === "system" ? "System" : "PilotSwarm"),
            timestamp: formatTimestamp(message?.createdAt || message?.time),
            body: decorateArtifactLinksForChat(message?.text || ""),
            width: Math.max(20, maxWidth),
            titleColor: message?.cardTitleColor || (message?.role === "system" ? "yellow" : "cyan"),
            borderColor: message?.cardBorderColor || "gray",
            ...(isSystemCard ? { bodyColor: "gray", fitToContent: true } : {}),
        });
    }

    const markdownLines = trimLeadingBlankLines(parseMarkdownLines(
        decorateArtifactLinksForChat(message?.text || ""),
        { width: maxWidth, tableMode: options.tableMode },
    ));
    const tintedMarkdownLines = tintRunsIfUnset(
        markdownLines,
        message?.pendingPhase === "cancelling"
            ? "red"
            : message?.role === "user" ? USER_CHAT_COLOR : null,
    );
    const prefix = options.skipPrefix ? [] : buildChatMessagePrefix(message);

    if (tintedMarkdownLines.length === 0) {
        return prefix.length > 0 ? [prefix] : [];
    }

    if (startsWithStructuredBlock(tintedMarkdownLines)) {
        return prefix.length > 0 ? [prefix, ...tintedMarkdownLines] : tintedMarkdownLines;
    }

    const renderedLines = [];
    let prefixRendered = prefix.length === 0;
    for (const lineRuns of tintedMarkdownLines) {
        if (!Array.isArray(lineRuns)) {
            if (!prefixRendered) {
                renderedLines.push(prefix);
                prefixRendered = true;
            }
            renderedLines.push(lineRuns);
            continue;
        }
        if (!prefixRendered) {
            renderedLines.push([...prefix, ...lineRuns]);
            prefixRendered = true;
        } else {
            renderedLines.push(lineRuns);
        }
    }
    return renderedLines;
}

// Activity-log event types that are not surfaced as live "recent action" lines
// in the chat pane: bookkeeping, high-frequency streaming noise, and the turn
// bracket markers (which don't read well as prose).
const LIVE_ACTIVITY_SKIP = new Set([
    "assistant.usage",
    "session.info",
    "session.idle",
    "session.usage_info",
    "pending_messages.modified",
    "pending_messages.cancelled",
    "abort",
    "assistant.turn_start",
    "assistant.turn_end",
    "assistant.streaming_progress",
    "session.turn_completed",
    "tool.execution_partial_result",
    "tool.execution_progress",
]);

// Format an elapsed duration for the live activity card header (e.g. "12s",
// "1m 05s", "1h 02m").
function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

// Fact-store, graph-store, and skill tools get first-class phases instead of
// the generic "running tool: X". Classification is pattern-based so new tools
// in these families inherit the right phase without a table update.
const FACTS_READ_TOOLS = new Set(["read_facts", "facts_search", "facts_similar", "facts_read_uncrawled", "facts_tombstone_stats"]);
const FACTS_WRITE_TOOLS = new Set(["store_fact", "delete_fact", "facts_set_crawled", "facts_purge_tombstones", "facts_force_purge"]);
function knowledgeToolPhase(name, starting) {
    const n = String(name || "").toLowerCase();
    if (n === "search_skills" || n.includes("skill")) {
        return starting ? "loading skills\u2026" : "loaded skills";
    }
    if (FACTS_READ_TOOLS.has(n)) return starting ? "reading facts\u2026" : "read facts";
    if (FACTS_WRITE_TOOLS.has(n)) return starting ? "writing facts\u2026" : "wrote facts";
    if (n.startsWith("graph_")) {
        const writes = /upsert|delete|archive|merge|remove|set_/.test(n);
        if (writes) return starting ? "writing to the graph\u2026" : "wrote to the graph";
        return starting ? "reading the graph\u2026" : "read the graph";
    }
    if (n.startsWith("facts_") || n.endsWith("_fact") || n.endsWith("_facts")) {
        // Unrecognized fact-family tool: read/write by verb.
        const writes = /store|write|set|delete|purge|update/.test(n);
        return writes ? (starting ? "writing facts\u2026" : "wrote facts") : (starting ? "reading facts\u2026" : "read facts");
    }
    return "";
}

// High-level phase for the live activity status line. Maps the newest
// activity event to a short human description ("thinking\u2026", "running tool:
// read_file\u2026") — never raw payloads; detail lives in the Inspector.
function liveActivityPhaseText(item) {
    const type = String(item?.eventType || "");
    if (type === "tool.execution_start" || type === "tool.execution_complete") {
        const raw = String(item?.text || "")
            .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .replace(/^[^A-Za-z0-9_]+/, "")
            .trim();
        const name = (raw.match(/^[A-Za-z0-9_.:-]+/) || [""])[0];
        if (!name) return "running tools\u2026";
        const knowledge = knowledgeToolPhase(name, type === "tool.execution_start");
        if (knowledge) return knowledge;
        const shortName = name.length > 28 ? `${name.slice(0, 27)}\u2026` : name;
        return type === "tool.execution_start"
            ? `running tool: ${shortName}\u2026`
            : `finished tool: ${shortName}`;
    }
    switch (type) {
        case "skill.invoked": return "loading skills\u2026";
        case "learned_skill.read": return "loading skills\u2026";
        case "skills.searched": return "loading skills\u2026";
        case "facts.searched":
        case "facts.similar": return "reading facts\u2026";
        case "graph.searched":
        case "graph.node_searched":
        case "graph.node_loaded": return "reading the graph\u2026";
        case "graph.namespace_mutated": return "writing to the graph\u2026";
        case "assistant.reasoning": return "thinking\u2026";
        case "assistant.intent": return "planning\u2026";
        case "assistant.message_start":
        case "assistant.message": return "writing reply\u2026";
        case "session.compaction_start": return "compacting context\u2026";
        case "session.compaction_complete": return "context compacted";
        case "session.dehydrated": return "dehydrating\u2026";
        case "session.hydrated":
        case "session.rehydrated": return "rehydrating\u2026";
        case "session.agent_spawned": return "coordinating agents\u2026";
        case "session.wait_started": return "waiting\u2026";
        case "session.input_required_started": return "awaiting input\u2026";
        case "session.lossy_handoff": return "moving to a new worker\u2026";
        case "session.error": return "recovering from an error\u2026";
        default: return "";
    }
}

// Single-line live activity status: while a turn is running, one dim line —
// spinner + "Working" + elapsed + a high-level phase. Replaces the old
// bordered multi-line card: hosts pin it OUTSIDE the scrolling transcript
// (portal: bottom-sticky strip above the composer; TUI: appended below the
// transcript, which autoscroll keeps at the bottom). Assistant messages can
// land before the turn is actually done (streamed/tool-interleaved replies),
// so visibility is governed by session status rather than transcript role.
// `options.spinnerFrame` animates the marker.
export function selectLiveActivityLines(state, options = {}) {
    if (state?.ui?.chatViewMode === "summary") return [];
    const session = selectActiveSession(state);
    if (!session || session.isGroup) return [];
    const status = String(session?.status || "").toLowerCase();
    if (status !== "running") return [];
    const history = state.history?.bySessionId?.get(session.sessionId) || null;
    // Latest user message anchors the elapsed clock when available.
    const chat = Array.isArray(history?.chat) ? history.chat : [];
    let turnStartAt = 0;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i]?.role === "user") {
            turnStartAt = Number(chat[i]?.createdAt || 0);
            break;
        }
    }
    const activity = Array.isArray(history?.activity) ? history.activity : [];
    // Current-turn boundaries. When a new turn starts, status flips to
    // "running" BEFORE fresh history lands; anchoring the clock on stale
    // data flashes a huge elapsed (the whole idle gap) that then snaps to
    // the real value. Anchor only on evidence belonging to THIS turn — a
    // user message or turn_start newer than the last turn end — and show
    // no timer (and no phase) until such evidence exists.
    let lastTurnStartAt = 0;
    let lastTurnEndAt = 0;
    for (let i = activity.length - 1; i >= 0; i -= 1) {
        const item = activity[i];
        const type = item?.eventType;
        const at = Number(item?.createdAt || 0);
        if (!lastTurnStartAt && type === "assistant.turn_start") lastTurnStartAt = at;
        if (!lastTurnEndAt && (type === "assistant.turn_end" || type === "session.turn_completed")) lastTurnEndAt = at;
        if (lastTurnStartAt && lastTurnEndAt) break;
    }
    let startAt = 0;
    if (turnStartAt > lastTurnEndAt) {
        startAt = turnStartAt;                       // user-triggered turn
    } else if (lastTurnStartAt > lastTurnEndAt) {
        startAt = lastTurnStartAt;                   // cron/command-triggered turn
    }
    let latest = null;
    for (let i = activity.length - 1; i >= 0; i -= 1) {
        const item = activity[i];
        if (!item || LIVE_ACTIVITY_SKIP.has(item.eventType)) continue;
        // Phase must come from the current turn — a stale "finished tool"
        // from the previous turn must not flash on turn start.
        if (Number(item.createdAt || 0) <= lastTurnEndAt) break;
        latest = item;
        break;
    }
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const elapsedLabel = startAt > 0 ? formatElapsed(nowMs - startAt) : "";
    const spinner = String(options.spinnerFrame || "").trim() || "\u25cf";
    const phase = latest ? liveActivityPhaseText(latest) : "";
    const runs = [
        { text: `${spinner} `, color: "cyan" },
        { text: "Working", color: "cyan" },
        ...(elapsedLabel ? [{ text: ` \u00b7 ${elapsedLabel}`, color: "gray" }] : []),
        ...(phase ? [{ text: ` \u2014 ${phase}`, color: "gray" }] : []),
    ];
    const maxWidth = Math.max(24, Math.min(120, Math.floor(Number(options.maxWidth) || 80)));
    return [fitRuns(runs, maxWidth)];
}

export function selectChatLines(state, maxWidth = 80, options = {}) {
    const messages = selectActiveChat(state);
    if (!messages || messages.length === 0) {
        return [{ text: "No messages yet.", color: "gray" }];
    }

    const buildOptions = options?.tableMode ? { tableMode: options.tableMode } : {};
    const lines = [];
    for (const [index, message] of messages.entries()) {
        const messageLines = buildChatMessageLines(message, maxWidth, buildOptions);
        appendChatBlockLines(lines, messageLines);
        const nextMessage = messages[index + 1];
        if (
            nextMessage
            && shouldInsertChatSpacer(message, nextMessage)
            && flattenLineText(lines[lines.length - 1]).trim().length > 0
        ) {
            lines.push(createBlankLine());
        }
    }
    return lines.length > 0 ? lines : [{ text: "No messages yet.", color: "gray" }];
}

export function selectOutboxOverlayLines(state, maxWidth = 80, options = {}) {
    const messages = selectActiveOutboxMessages(state);
    if (!messages || messages.length === 0) return [];

    const safeWidth = Math.max(20, Number(maxWidth) || 80);
    const queuedCount = messages.filter((message) => message.pendingPhase === "queued").length;
    const pendingCount = messages.filter((message) => message.pendingPhase === "pending").length;
    const cancellingCount = messages.filter((message) => message.pendingPhase === "cancelling").length;
    const parts = [];
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (queuedCount > 0) parts.push(`${queuedCount} queued`);
    if (cancellingCount > 0) parts.push(`${cancellingCount} cancelling`);
    const label = parts.length > 0 ? parts.join(" · ") : "queued prompts";
    const labelText = ` queued prompts: ${label} `;
    const rightRule = Math.max(1, safeWidth - labelText.length);
    const lines = [
        [
            { text: labelText, color: "gray" },
            { text: "─".repeat(rightRule), color: "gray" },
        ],
    ];

    const buildOptions = options?.tableMode ? { tableMode: options.tableMode } : {};
    for (const [index, message] of messages.entries()) {
        appendChatBlockLines(lines, buildChatMessageLines(message, safeWidth, buildOptions));
        const nextMessage = messages[index + 1];
        if (
            nextMessage
            && shouldInsertChatSpacer(message, nextMessage)
            && flattenLineText(lines[lines.length - 1]).trim().length > 0
        ) {
            lines.push(createBlankLine());
        }
    }
    return lines;
}

export function selectActiveArtifactLinks(state) {
    const messages = selectActiveChat(state);
    const links = [];
    const seen = new Set();

    for (const message of messages || []) {
        for (const link of extractArtifactLinks(message?.text || "")) {
            const key = `${link.sessionId}/${link.filename}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push(link);
        }
    }

    return links;
}

export function selectActiveHttpLinks(state) {
    const messages = selectActiveChat(state);
    const links = [];
    const seen = new Set();

    for (const message of messages || []) {
        for (const link of extractHttpLinks(message?.text || "")) {
            const href = String(link.href || "").trim();
            if (!href || seen.has(href)) continue;
            seen.add(href);
            links.push({
                href,
                text: String(link.text || href).trim() || href,
            });
        }
    }

    return links;
}

function shortModelReasoningLabel(model, reasoningEffort) {
    const modelName = shortModelName(model);
    if (!modelName) return "";
    const effort = String(reasoningEffort || "").trim();
    return effort ? `${modelName}:${effort}` : modelName;
}

function shortBucketModelLabel(model) {
    return shortModelName(model) || "(unknown)";
}

export function selectChatPaneChrome(state, options = {}) {
    const session = selectActiveSession(state);
    const sessionsById = state.sessions?.byId || {};
    const sessionsFlat = Array.isArray(state.sessions?.flat) ? state.sessions.flat : [];
    const totalDescendantCounts = getTotalDescendantCounts(sessionsById);
    const visibleDescendantCounts = getVisibleDescendantCounts(sessionsFlat, sessionsById);
    const compactSecondaryMeta = shouldCompactPaneTitleMetadata(options?.width);

    if (!session) {
        return {
            color: "cyan",
            title: buildPaneTitleRuns("Chat", "cyan"),
            titleRight: null,
            animateTitleRight: false,
        };
    }

    const shortId = shortSessionId(session.sessionId);
    const mainColor = session.isSystem ? "yellow" : "cyan";
    const title = buildPaneTitleRuns(
        session.isSystem
            ? `⚙ ${canonicalSystemTitle(session, state.branding?.title || "PilotSwarm")}`
            : (buildSessionDisplayTitle(session) || "Chat"),
        mainColor,
    );

    const activeEntry = sessionsFlat.find((entry) => entry.sessionId === session.sessionId);
    const collapseBadge = getCollapseBadge(session.sessionId, activeEntry, totalDescendantCounts, visibleDescendantCounts);
    if (collapseBadge) {
        title.push({ text: ` ${collapseBadge.text}`, color: collapseBadge.color });
    }

    if (!compactSecondaryMeta) {
        title.push({ text: ` [${shortId}]`, color: "gray" });
    }

    const history = state.history?.bySessionId?.get(session.sessionId) || null;
    const outboxItems = Array.isArray(state.outbox?.bySessionId?.[session.sessionId])
        ? state.outbox.bySessionId[session.sessionId]
        : [];
    const progress = state.ui?.chatViewMode === "summary"
        ? null
        : buildLiveProgressState(session, history, history?.chat || [], outboxItems);

    // Border top-right: status · model · context (mirrors the session-row meta),
    // with the live turn-progress label appended while a turn is running.
    const mode = state.connection?.mode || "local";
    const metaRuns = buildSelectedSessionMetaRuns(session, mode);
    const progressRuns = buildChatProgressTitleRuns(progress);
    const titleRight = progressRuns
        ? [...metaRuns, ...(metaRuns.length ? [{ text: " · ", color: "gray" }] : []), ...progressRuns]
        : metaRuns;

    return {
        color: session.isSystem ? "yellow" : "cyan",
        title,
        titleRight: titleRight.length ? titleRight : null,
        animateTitleRight: Boolean(progress),
    };
}

export function selectActiveActivity(state) {
    const sessionId = state.sessions.activeSessionId;
    if (!sessionId) return [];
    const history = state.history.bySessionId.get(sessionId);
    return history?.activity || [];
}

export function selectActivityPane(state, maxLines = 12) {
    const activity = selectActiveActivity(state);
    const session = selectActiveSession(state);
    const title = buildPaneTitleRuns("Activity", "gray");

    if (session?.isGroup) {
        return {
            title,
            disabled: true,
            lines: [{ text: SELECT_SESSION_DETAILS_MESSAGE, color: "gray" }],
        };
    }

    if (session?.statusVersion != null) {
        title.push({
            text: ` [current session v${session.statusVersion}]`,
            color: "gray",
        });
    }

    return {
        title,
        lines: activity.length > 0
            ? activity.map((item) => item.line || [{ text: item.text, color: "white" }])
            : [{ text: "No activity yet", color: "gray" }],
    };
}

function logLevelColor(level) {
    switch (String(level || "").toLowerCase()) {
        case "error": return "red";
        case "warn": return "yellow";
        case "debug": return "blue";
        case "trace": return "magenta";
        case "info":
        default:
            return "green";
    }
}

function logCategoryColor(category, level) {
    if (category === "orchestration") return "magenta";
    if (category === "activity") return "cyan";
    return logLevelColor(level);
}

function formatLogFormatLabel(format) {
    return format === "raw" ? "raw summary" : "pretty text";
}

function currentOrchestrationIdForSession(session) {
    if (!session?.sessionId) return null;
    return `session-${session.sessionId}`;
}

function filterLogEntries(state, session) {
    const entries = Array.isArray(state.logs?.entries) ? state.logs.entries : [];
    const filter = state.logs?.filter || {};
    const activeOrchestrationId = currentOrchestrationIdForSession(session);

    return entries.filter((entry) => {
        if (!entry) return false;
        if (filter.source === "currentOrchestration" && activeOrchestrationId) {
            if (entry.orchId !== activeOrchestrationId) return false;
        }
        if (filter.level && filter.level !== "all") {
            if (String(entry.level || "").toLowerCase() !== filter.level) return false;
        }
        return true;
    });
}

function buildRawLogLine(entry) {
    const podLabel = shortNodeLabel(entry?.podName) || entry?.podName || "node";
    const sessionId = entry?.sessionId
        || (String(entry?.orchId || "").startsWith("session-") ? String(entry.orchId).slice("session-".length) : "");
    const level = String(entry?.level || "info").toUpperCase();
    const categoryMarker = entry?.category === "orchestration"
        ? "◆"
        : entry?.category === "activity"
            ? "●"
            : "•";
    return [
        { text: `[${entry?.time || "--:--:--"}] `, color: "gray" },
        { text: `${categoryMarker} `, color: logCategoryColor(entry?.category, entry?.level) },
        { text: `${podLabel} `, color: "white", bold: true },
        ...(sessionId ? [{ text: `[${shortSessionId(sessionId)}] `, color: "gray" }] : []),
        { text: `${level} `, color: logLevelColor(entry?.level), bold: true },
        { text: entry?.rawLine || entry?.message || "", color: "white" },
    ];
}

function buildPrettyLogLine(entry) {
    const sessionId = entry?.sessionId
        || (String(entry?.orchId || "").startsWith("session-") ? String(entry.orchId).slice("session-".length) : "");
    return [{
        text: `${sessionId ? `[${shortSessionId(sessionId)}] ` : ""}${entry?.prettyMessage || entry?.message || entry?.rawLine || ""}`,
        color: logCategoryColor(entry?.category, entry?.level),
        bold: String(entry?.level || "").toLowerCase() === "warn" || String(entry?.level || "").toLowerCase() === "error",
    }];
}

function selectLogPane(state, session) {
    const logs = state.logs || {};
    const filter = logs.filter || {};
    const summaryRuns = [
        { text: "Scope: ", color: "gray" },
        { text: filter.source === "currentOrchestration" ? "current orchestration" : "all nodes", color: "white" },
        { text: "  Level: ", color: "gray" },
        { text: filter.level || "all", color: "white" },
        { text: "  Format: ", color: "gray" },
        { text: formatLogFormatLabel(filter.format), color: "white" },
    ];

    if (!logs.available) {
        return [
            { text: logs.availabilityReason || "Log tailing disabled: no K8S_CONTEXT configured in the env file.", color: "yellow" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    if (!logs.tailing) {
        return [
            { text: "Press t to start log tailing.", color: "cyan", bold: true },
            { text: "Press f to open log filters.", color: "gray" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    const entries = filterLogEntries(state, session);
    if (entries.length === 0) {
        return [
            { text: "Tailing logs…", color: "cyan" },
            { text: "No logs match the current filter yet.", color: "gray" },
            { text: "", color: "gray" },
            summaryRuns,
        ];
    }

    return [
        summaryRuns,
        { text: "", color: "gray" },
        ...entries.map((entry) => filter.format === "raw" ? buildRawLogLine(entry) : buildPrettyLogLine(entry)),
    ];
}

function isMarkdownFilename(filename) {
    return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(filename || ""));
}

function isJsonFilename(filename) {
    return /\.(json|jsonl)$/i.test(String(filename || ""));
}

function buildFileTabRuns(activeTab) {
    return INSPECTOR_TABS.map((tab) => ({
        text: tab === activeTab ? `[${tab}] ` : `${tab} `,
        color: tab === activeTab ? "magenta" : "gray",
        bold: tab === activeTab,
    }));
}

function buildPlainFilePreviewLines(content = "") {
    const lines = String(content || "").split("\n");
    return lines.length > 0
        ? lines.map((line) => ({ text: line, color: "white" }))
        : [{ text: "", color: "white" }];
}

function buildFileListEntry(filename, { selected = false, width = 24, label = null } = {}) {
    const safeWidth = Math.max(8, width);
    const prefix = isMarkdownFilename(filename)
        ? "# "
        : isJsonFilename(filename)
            ? "{ "
            : "• ";
    const text = fitDisplayText(`${prefix}${label || filename}`, safeWidth).padEnd(safeWidth, " ");
    if (selected) {
        return buildActiveHighlightLine(text);
    }
    return {
        text,
        color: isMarkdownFilename(filename) ? "cyan" : "white",
        bold: false,
    };
}

export function selectFilesScope(state) {
    return state.files?.filter?.scope === "allSessions" ? "allSessions" : "selectedSession";
}

function buildDescendantSessionIdSet(rootSessionId, byId = {}) {
    if (!rootSessionId) return new Set();
    const { childMap } = buildChildMaps(byId);
    const seen = new Set([rootSessionId]);
    const queue = [rootSessionId];
    while (queue.length > 0) {
        const current = queue.shift();
        const childIds = childMap.get(current) || [];
        for (const childId of childIds) {
            if (!childId || seen.has(childId)) continue;
            seen.add(childId);
            queue.push(childId);
        }
    }
    return seen;
}

export function selectFileSessionIdsForScope(state, scope = selectFilesScope(state)) {
    const activeSessionId = selectActiveSession(state)?.sessionId || null;
    const flatSessionIds = Array.isArray(state.sessions?.flat)
        ? state.sessions.flat.map((entry) => entry?.sessionId || entry).filter(Boolean)
        : [];
    const fileSessionIds = Object.keys(state.files?.bySessionId || {}).filter(Boolean);

    if (scope === "allSessions") {
        return [...new Set([
            ...flatSessionIds,
            ...fileSessionIds,
        ])];
    }

    const scopedSessionIds = buildDescendantSessionIdSet(activeSessionId, state.sessions?.byId || {});
    if (scopedSessionIds.size === 0) return [];

    const ordered = [];
    const seen = new Set();
    for (const sessionId of [activeSessionId, ...flatSessionIds, ...Object.keys(state.sessions?.byId || {}), ...fileSessionIds]) {
        if (!sessionId || seen.has(sessionId) || !scopedSessionIds.has(sessionId)) continue;
        ordered.push(sessionId);
        seen.add(sessionId);
    }
    for (const sessionId of scopedSessionIds) {
        if (seen.has(sessionId)) continue;
        ordered.push(sessionId);
    }
    return ordered;
}

export function selectFileBrowserItems(state) {
    const scope = selectFilesScope(state);
    const activeSessionId = selectActiveSession(state)?.sessionId || null;
    const query = state.files?.filter?.query || "";
    const orderedSessionIds = selectFileSessionIdsForScope(state, scope);
    const showSessionPrefixes = scope === "allSessions" || orderedSessionIds.length > 1;

    const items = [];
    for (const sessionId of orderedSessionIds) {
        const entries = normalizeArtifactEntries(state.files?.bySessionId?.[sessionId]?.entries);
        for (const entry of entries) {
            const filename = entry.filename;
            items.push({
                id: `${sessionId}/${filename}`,
                sessionId,
                filename,
                entry,
                label: showSessionPrefixes
                    ? `[${shortSessionId(sessionId)}] ${filename}`
                    : filename,
            });
        }
    }
    return items.filter((item) => (
        matchesSearchQuery(item.filename, query)
        || matchesSearchQuery(item.sessionId, query)
        || matchesSearchQuery(item.label, query)
    ));
}

export function selectSelectedFileBrowserItem(state) {
    const items = selectFileBrowserItems(state);
    if (items.length === 0) return null;

    const preferredId = state.files?.selectedArtifactId || null;
    if (preferredId) {
        const selected = items.find((item) => item.id === preferredId);
        if (selected) return selected;
    }

    const scope = selectFilesScope(state);
    if (scope === "allSessions") {
        const activeSessionId = selectActiveSession(state)?.sessionId || null;
        const activeFilename = activeSessionId
            ? state.files?.bySessionId?.[activeSessionId]?.selectedFilename || null
            : null;
        if (activeSessionId && activeFilename) {
            const activeSelected = items.find((item) => item.sessionId === activeSessionId && item.filename === activeFilename);
            if (activeSelected) return activeSelected;
        }
        return items[0];
    }

    const activeSessionId = selectActiveSession(state)?.sessionId || null;
    const selectedFilename = activeSessionId
        ? state.files?.bySessionId?.[activeSessionId]?.selectedFilename || null
        : null;
    return items.find((item) => item.sessionId === activeSessionId && item.filename === selectedFilename)
        || items[0];
}

export function selectFilesView(state, options = {}) {
    const session = selectActiveSession(state);
    const listWidth = Math.max(12, Number(options?.listWidth) || Number(options?.width) || 24);
    const previewWidth = Math.max(18, Number(options?.previewWidth) || Number(options?.width) || 36);
    const showHints = options?.showHints !== false;
    const sessionId = session?.sessionId || null;
    const scope = selectFilesScope(state);
    const query = state.files?.filter?.query || "";
    const fileItems = selectFileBrowserItems(state);
    const selectedItem = selectSelectedFileBrowserItem(state);
    const selectedFilename = selectedItem?.filename || null;
    const selectedIndex = Math.max(0, fileItems.findIndex((item) => item.id === selectedItem?.id));
    const previewState = selectedItem?.sessionId && selectedFilename
        ? state.files?.bySessionId?.[selectedItem.sessionId]?.previews?.[selectedFilename] || null
        : null;
    const previewArtifact = previewState || selectedItem?.entry || null;
    const shortId = session ? shortSessionId(session.sessionId) : "";
    const scopedSessionIds = selectFileSessionIdsForScope(state, scope);
    const subtreeScope = scope !== "allSessions" && scopedSessionIds.some((id) => id && id !== sessionId);
    const allSessionIds = [...new Set([
        ...(Array.isArray(state.sessions?.flat) ? state.sessions.flat.map((entry) => entry?.sessionId || entry) : []),
        ...Object.keys(state.files?.bySessionId || {}),
    ])].filter(Boolean);
    const allSessionsLoading = scope === "allSessions" && allSessionIds.some((id) => !state.files?.bySessionId?.[id]?.loaded || state.files?.bySessionId?.[id]?.loading);
    const allSessionsError = scope === "allSessions"
        ? allSessionIds.map((id) => state.files?.bySessionId?.[id]?.error).find(Boolean) || null
        : null;

    const listLines = [
        buildFileTabRuns("files"),
        ...((session || scope === "allSessions")
            ? []
            : [{ text: "No session selected.", color: "gray" }]),
    ];

    if (scope === "allSessions") {
        if (allSessionsLoading && fileItems.length === 0) {
            listLines.push({ text: "Loading exported files across all sessions…", color: "gray" });
        } else if (allSessionsError && fileItems.length === 0) {
            listLines.push({ text: allSessionsError, color: "red" });
        } else if (fileItems.length === 0) {
            listLines.push({
                text: query
                    ? `No artifacts matched "${query}" across any session.`
                    : "No exported files across any session yet.",
                color: "gray",
            });
            listLines.push({
                text: query
                    ? "Clear the query or switch back to the selected session."
                    : "Switch the filter back to the selected session or wait for agents to export artifacts.",
                color: "gray",
            });
        } else {
            listLines.push(...fileItems.map((item, index) => buildFileListEntry(item.filename, {
                selected: index === selectedIndex,
                width: listWidth,
                label: item.label,
            })));
        }
    } else if (session) {
        const fileState = sessionId ? state.files?.bySessionId?.[sessionId] : null;
        const entries = Array.isArray(fileState?.entries) ? fileState.entries : [];
        const scopedItems = fileItems.filter((item) => scopedSessionIds.includes(item.sessionId));
        if (fileState?.loading) {
            listLines.push({ text: "Loading exported files…", color: "gray" });
        } else if (fileState?.error) {
            listLines.push({ text: fileState.error, color: "red" });
        } else if (scopedItems.length === 0 && scopedSessionIds.every((id) => {
            const scopedEntries = state.files?.bySessionId?.[id]?.entries;
            return !Array.isArray(scopedEntries) || scopedEntries.length === 0;
        })) {
            listLines.push({
                text: query
                    ? `No artifacts matched "${query}" for this ${subtreeScope ? "session tree" : "session"}.`
                    : `No exported files for this ${subtreeScope ? "session tree" : "session"} yet.`,
                color: "gray",
            });
            listLines.push({
                text: query
                    ? "Clear the query or upload an artifact to this session."
                    : subtreeScope
                        ? "Artifacts exported by this session or any child session will appear here."
                        : "Agents must write/export artifacts before they appear here.",
                color: "gray",
            });
        } else {
            listLines.push(...scopedItems.map((item, index) => buildFileListEntry(item.filename, {
                selected: index === selectedIndex,
                width: listWidth,
                label: item.label,
            })));
        }
    }

    let previewLines;
    let previewTitle;
    if (!session && scope !== "allSessions") {
        previewTitle = [{ text: "Preview", color: "cyan", bold: true }];
        previewLines = [{ text: "No session selected.", color: "gray" }];
    } else if (!selectedFilename) {
        previewTitle = [{ text: "Preview", color: "cyan", bold: true }];
        previewLines = [{ text: "Select a file to preview it here.", color: "gray" }];
    } else if (previewState?.loading) {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(((scope === "allSessions") || (selectedItem?.sessionId && selectedItem.sessionId !== sessionId))
                && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
        ];
        previewLines = [{ text: "Loading file preview…", color: "gray" }];
    } else if (previewState?.error) {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(((scope === "allSessions") || (selectedItem?.sessionId && selectedItem.sessionId !== sessionId))
                && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
        ];
        previewLines = [{ text: previewState.error, color: "red" }];
    } else {
        previewTitle = [
            { text: `Preview: ${selectedFilename}`, color: "cyan", bold: true },
            ...(((scope === "allSessions") || (selectedItem?.sessionId && selectedItem.sessionId !== sessionId))
                && selectedItem?.sessionId
                ? [{ text: ` · ${shortSessionId(selectedItem.sessionId)}`, color: "gray" }]
                : []),
            ...(previewState?.renderMode === "markdown"
                ? [{ text: " [md]", color: "gray" }]
                : previewState?.isBinary === true
                    ? [{ text: " [file]", color: "gray" }]
                    : previewState?.renderMode === "note"
                        ? [{ text: " [note]", color: "gray" }]
                    : []),
        ];
        previewLines = previewState?.renderMode === "markdown"
            ? trimLeadingBlankLines(parseMarkdownLines(previewState?.content || "", { width: previewWidth }))
            : buildPlainFilePreviewLines(previewState?.content || "");
    }

    // Mobile-friendly title: drop the redundant "Files: " prefix
    // because the active inspector tab below already says "Files".
    // The shorter title leaves room for action buttons (Upload /
    // Download / Filter / Focus) on a single header row on phones.
    const panelTitleLabel = scope === "allSessions"
        ? "Files: all sessions"
        : session
            ? `Files: ${shortId}${subtreeScope ? " tree" : ""}`
            : "Files";
    const panelTitleLabelMobile = scope === "allSessions"
        ? "all sessions"
        : session
            ? `${shortId}${subtreeScope ? " tree" : ""}`
            : "Files";
    const listTitleLabel = scope === "allSessions"
        ? `Artifacts${fileItems.length > 0 ? ` [${fileItems.length}]` : ""}`
        : `Artifacts${subtreeScope ? " tree" : ""}${fileItems.length > 0 ? ` [${fileItems.length}]` : ""}`;
    const querySuffix = query ? ` · @${query}` : "";

    return {
        panelTitle: [{ text: `${panelTitleLabel}${querySuffix}`, color: "magenta", bold: true }],
        panelTitleMobile: [{ text: `${panelTitleLabelMobile}${querySuffix}`, color: "magenta", bold: true }],
        listTitle: [{ text: `${listTitleLabel}${querySuffix}`, color: "cyan", bold: true }],
        listLines,
        listBodyLines: listLines.slice(1),
        selectedIndex,
        selectedFilename,
        selectedSessionId: selectedItem?.sessionId || null,
        scope,
        previewTitle,
        previewLines,
        previewContent: previewState?.content || "",
        previewContentType: previewState?.contentType || "",
        previewRenderMode: previewState?.renderMode || null,
        previewIsBinary: previewArtifact?.isBinary === true,
        previewSizeBytes: previewArtifact?.sizeBytes ?? null,
        previewUploadedAt: previewArtifact?.uploadedAt || "",
        previewSource: previewArtifact?.source || null,
        previewError: previewState?.error || null,
        previewLoading: Boolean(previewState?.loading),
        previewScrollOffset: state.ui.scroll.filePreview || 0,
        fullscreen: Boolean(state.files?.fullscreen),
        fullscreenTitle: [
            { text: panelTitleLabel, color: "magenta", bold: true },
            ...(selectedFilename
                ? [
                    { text: " · ", color: "gray" },
                    { text: selectedFilename, color: "cyan", bold: true },
                ]
                : []),
            ...(showHints
                ? [{ text: "  [f filter] [u upload] [a download] [x delete] [o open] [v/esc close fullscreen]", color: "gray" }]
                : []),
        ],
    };
}

/**
 * Project the Admin Console view-model. Returns the props needed to
 * render the admin pane in either the native TUI or the portal: the
 * current principal label, the GitHub Copilot key state (configured /
 * editing / saving / error), and a small set of "actions" describing
 * what keybindings or buttons are currently meaningful.
 */
export function selectAdminConsole(state) {
    const admin = state.admin || {};
    const profile = admin.profile || null;
    const ghcpKey = admin.ghcpKey || { editing: false, draft: "", saving: false, error: null };
    const principal = profile
        ? {
            provider: profile.provider || "",
            subject: profile.subject || "",
            email: profile.email || null,
            displayName: profile.displayName || null,
        }
        : (state.auth?.principal || null);

    const systemGhcpKey = admin.systemGhcpKey || { supported: false, loading: false, configured: false, changedBy: null, changedAt: null, error: null };
    const isAdmin = Boolean(profile?.isAdmin);
    // Admin-only target switch: when on, Set/Replace/Clear act on the
    // SYSTEM user's key (ownerless system sessions run on it).
    const storeAsSystem = isAdmin && Boolean(ghcpKey.storeAsSystem);
    const targetConfigured = storeAsSystem ? Boolean(systemGhcpKey.configured) : Boolean(profile?.githubCopilotKeySet);
    const keyNoun = storeAsSystem ? "System key" : "key";

    const systemProvenance = systemGhcpKey.configured && systemGhcpKey.changedBy
        ? ` (set by ${systemGhcpKey.changedBy})`
        : "";
    const ghcpStatusText = ghcpKey.saving
        ? "Saving..."
        : ghcpKey.editing
            ? "Editing — Enter to save, Esc to cancel"
            : storeAsSystem
                ? (systemGhcpKey.configured
                    ? `System key configured — ownerless system sessions use it for GitHub Copilot models${systemProvenance}`
                    : "System key not configured — ownerless system sessions fall back to env GITHUB_TOKEN")
                : (profile?.githubCopilotKeySet
                    ? "Configured (overrides env GITHUB_TOKEN for this user)"
                    : "Not configured (using env GITHUB_TOKEN fallback)");

    const actions = [];
    if (!ghcpKey.editing) {
        actions.push({ id: "edit", label: targetConfigured ? `Replace ${keyNoun}` : `Set ${keyNoun}`, key: "e" });
        if (targetConfigured) {
            actions.push({ id: "clear", label: `Clear ${keyNoun}`, key: "c" });
        }
        actions.push({ id: "refresh", label: "Refresh", key: "r" });
    } else {
        actions.push({ id: "save", label: "Save", key: "Enter" });
        actions.push({ id: "cancel", label: "Cancel", key: "Esc" });
    }
    actions.push({ id: "close", label: "Close console", key: ghcpKey.editing ? "Ctrl+Esc" : "Esc" });

    return {
        visible: Boolean(admin.visible),
        loading: Boolean(admin.loading),
        loadError: admin.loadError || null,
        principal,
        isAdmin,
        ghcpKey: {
            configured: Boolean(profile?.githubCopilotKeySet),
            targetConfigured,
            storeAsSystem,
            editing: Boolean(ghcpKey.editing),
            draft: ghcpKey.draft || "",
            cursorIndex: Math.max(0, Math.min(Number(ghcpKey.cursorIndex) || 0, String(ghcpKey.draft || "").length)),
            saving: Boolean(ghcpKey.saving),
            error: ghcpKey.error || null,
            statusText: ghcpStatusText,
        },
        systemGhcpKey: {
            supported: Boolean(systemGhcpKey.supported),
            loading: Boolean(systemGhcpKey.loading),
            configured: Boolean(systemGhcpKey.configured),
            changedBy: systemGhcpKey.changedBy || null,
            changedAt: systemGhcpKey.changedAt || null,
            error: systemGhcpKey.error || null,
        },
        actions,
    };
}

/**
 * Native-TUI view-model for the GitHub Copilot key editor overlay.
 * Returns `null` when the user is not currently editing — the TUI
 * mounts the overlay only when this returns a value, mirroring the
 * `selectRenameSessionModal` pattern.
 *
 * The portal does not consume this selector; its inline `<input>`
 * already provides browser-native focus, cursor, and selection
 * handling, so a synthetic cursor view-model would be redundant there.
 */
export function selectAdminGhcpKeyEditorModal(state, maxWidth = 76) {
    const admin = state.admin || {};
    const ghcpKey = admin.ghcpKey || {};
    if (!admin.visible || !ghcpKey.editing) return null;

    const value = String(ghcpKey.draft || "");
    // Mask the displayed text so an over-the-shoulder reader cannot
    // capture the key while it is being typed. The cursor position is
    // preserved as-is because the masked length matches the source.
    const maskedValue = value ? "•".repeat(value.length) : "";

    const helpLines = [
        [
            { text: "Enter", color: "cyan", bold: true },
            { text: " save  ", color: "gray" },
            { text: "Esc", color: "cyan", bold: true },
            { text: " cancel", color: "gray" },
        ],
        [{ text: "", color: "gray" }],
        [{
            text: "The key is stored in CMS and used by the worker instead of the env",
            color: "gray",
        }],
        [{
            text: "GITHUB_TOKEN for sessions you own. Use the Clear button to revert.",
            color: "gray",
        }],
    ];

    const detailsLines = [
        [
            { text: "Configured: ", color: "gray" },
            {
                text: ghcpKey.configured ? "yes (will be replaced)" : "no",
                color: ghcpKey.configured ? "yellow" : "white",
            },
        ],
        [
            { text: "Length:     ", color: "gray" },
            { text: String(value.length), color: value.length > 0 ? "white" : "gray" },
        ],
    ];

    return {
        title: "GitHub Copilot Key",
        value,
        displayValue: maskedValue,
        cursorIndex: Math.max(0, Math.min(Number(ghcpKey.cursorIndex) || 0, value.length)),
        placeholder: "Paste your GitHub Copilot key",
        helpTitle: "Key Editor",
        helpLines,
        detailsLines,
        saving: Boolean(ghcpKey.saving),
        error: ghcpKey.error || null,
        idealWidth: Math.min(72, Math.max(56, maxWidth)),
    };
}

export function selectStatusBar(state) {
    const focus = state.ui.focusRegion;
    const paneFullscreen = state.ui.fullscreenPane || null;
    const activeSession = selectActiveSession(state);
    const hasPendingQuestion = Boolean(activeSession?.pendingQuestion?.question);
    const activeOutbox = activeSession?.sessionId && Array.isArray(state.outbox?.bySessionId?.[activeSession.sessionId])
        ? state.outbox.bySessionId[activeSession.sessionId]
        : [];
    const hasOutbox = activeOutbox.length > 0;
    const hasPendingOutbox = activeOutbox.some((item) => item?.phase === "pending");
    const editingPendingOutbox = state.ui.promptEdit?.sessionId === activeSession?.sessionId;
    const selectedQueuedOutbox = editingPendingOutbox && state.ui.promptEdit?.phase === "queued";
    const selectedCancellingOutbox = editingPendingOutbox && state.ui.promptEdit?.phase === "cancelling";
    const fullscreenHint = paneFullscreen === focus ? "v/esc close fullscreen" : "v fullscreen";
    if (state.ui.modal?.type === "artifactUpload") {
        return {
            left: "Upload a local file into this session's artifact store",
            right: "type path · left/right move · enter upload · esc cancel",
        };
    }
    if (state.ui.modal?.type === "renameSession") {
        return {
            left: "Rename the selected session title",
            right: "type title · left/right move · enter save · esc cancel",
        };
    }
    if (state.ui.modal?.type === "artifactPicker") {
        return {
            left: "Select a linked artifact or URL",
            right: "up/down move · enter open/download · a/esc close",
        };
    }
    if (state.ui.modal?.type === "modelPicker") {
        return {
            left: "Select a model for the new session",
            right: "up/down move · enter next · esc cancel",
        };
    }
    if (state.ui.modal?.type === "reasoningEffortPicker") {
        return {
            left: "Select reasoning effort for the new session",
            right: "up/down move · enter create · esc cancel",
        };
    }
    if (state.ui.modal?.type === "themePicker") {
        return {
            left: "Select a shared portal/TUI theme",
            right: "up/down move · enter apply · esc close",
        };
    }
    if (state.ui.modal?.type === "sessionAgentPicker") {
        return {
            left: "Select an agent for the new session",
            right: "up/down move · enter create · esc cancel",
        };
    }
    if (state.ui.modal?.type === "sessionGroupPicker") {
        return {
            left: "Move selected session(s) to a group",
            right: "up/down move · enter choose · esc cancel",
        };
    }
    if (state.ui.modal?.type === "sessionGroupName") {
        return {
            left: "Name the new group",
            right: "type name · left/right move · enter create · esc cancel",
        };
    }
    if (state.ui.modal?.type === "logFilter") {
        return {
            left: "Adjust log filters",
            right: "tab/shift-tab filter · up/down change · enter close · esc close",
        };
    }
    if (state.ui.modal?.type === "filesFilter") {
        return {
            left: "Adjust files browser filters",
            right: "tab/shift-tab filter · up/down change · enter close · esc close",
        };
    }
    if (state.ui.modal?.type === "sessionOwnerFilter") {
        return {
            left: "Adjust session filters",
            right: "up/down choose · space toggle · esc close",
        };
    }
    const selectMode = Boolean(state.sessions?.selectMode);
    const selectedCount = Array.isArray(state.sessions?.selectedIds) ? state.sessions.selectedIds.length : 0;
    if (selectMode && focus === FOCUS_REGIONS.SESSIONS) {
        return {
            left: `Select mode · ${selectedCount} selected`,
            right: "up/down move · space toggle · ctrl-g group · c cancel · d complete · D hard delete · V/esc exit",
        };
    }
    const chatViewMode = state.ui?.chatViewMode === "summary" ? "summary" : "transcript";
    const chatViewHint = chatViewMode === "summary" ? "s transcript" : "s summary";
    const hints = {
        [FOCUS_REGIONS.SESSIONS]: `up/down switch · ctrl-u/ctrl-d page · ctrl-g move group · f filter · P pin · V select · d done · D delete · r refresh · t title · ${fullscreenHint} · [/] resize pane · {/} columns · T themes · ? help · a linked items · drag copy · tab next pane · p prompt`,
        [FOCUS_REGIONS.CHAT]: `${chatViewHint} · j/k scroll · ctrl-u/ctrl-d page · e older history · g/G top/bottom · d done · ${fullscreenHint} · [/] resize pane · {/} columns · T themes · ? help · a linked items · drag copy · tab next pane · p prompt`,
        [FOCUS_REGIONS.INSPECTOR]: state.ui.inspectorTab === "logs"
            ? `j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · t tail · f filter · ${fullscreenHint} · left/right tab · [/] resize pane · {/} columns · T themes · ? help · a linked items · drag copy · tab next pane`
            : state.ui.inspectorTab === "stats"
                ? `j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · f cycle session/fleet/users · d done · ${fullscreenHint} · left/right tab · [/] resize pane · {/} columns · T themes · ? help · m next tab · tab next pane`
            : state.ui.inspectorTab === "files"
                ? state.files?.fullscreen
                    ? "a download · x delete · u/ctrl-a upload · o open · f filter · j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · v/esc close fullscreen · left/right tab · [/] resize pane · {/} columns · T themes · ? help · tab next pane"
                    : "j/k files · a download · x delete · u/ctrl-a upload · o open · f filter · ctrl-u/ctrl-d page preview · g/G preview top/bottom · d done · v fullscreen · left/right tab · [/] resize pane · {/} columns · T themes · ? help · tab next pane"
                : state.ui.inspectorTab === "history"
                    ? `j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · f format · r refresh · a save artifact · d done · ${fullscreenHint} · left/right tab · [/] resize pane · {/} columns · T themes · ? help · m next tab · tab next pane`
                    : state.ui.inspectorTab === "sequence"
                        ? `j/k turn · enter expand · ctrl-u/ctrl-d page · g/G top/bottom · d done · ${fullscreenHint} · left/right tab · [/] resize pane · {/} columns · T themes · ? help · m next tab · tab next pane`
                        : `j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · ${fullscreenHint} · left/right tab · [/] resize pane · {/} columns · T themes · ? help · h/l focus · a linked items · drag copy · m next tab · tab next pane`,
        [FOCUS_REGIONS.ACTIVITY]: `j/k scroll · ctrl-u/ctrl-d page · g/G top/bottom · d done · ${fullscreenHint} · [/] resize pane · {/} columns · T themes · ? help · a linked items · drag copy · h left · tab next pane`,
        [FOCUS_REGIONS.PROMPT]: hasPendingQuestion
            ? `type answer · enter reply · alt-enter newline · T themes · ? help · arrows move · alt-left/right word · alt-delete word · @ artifacts · @@ sessions · ${paneFullscreen ? "esc pane" : "esc sessions"}`
            : editingPendingOutbox
                ? selectedQueuedOutbox
                    ? `queued prompt selected · d delete · up/down cycle queued · enter/esc new prompt · ${paneFullscreen ? "esc pane" : "esc sessions"}`
                    : selectedCancellingOutbox
                        ? `cancelling prompt selected · up/down cycle queued · enter/esc new prompt · ${paneFullscreen ? "esc pane" : "esc sessions"}`
                        : `edit pending prompt · enter send batch · up/down cycle pending · esc cancel · alt-enter newline · @ artifacts · @@ sessions · ${paneFullscreen ? "esc pane" : "esc sessions"}`
                : hasPendingOutbox
                    ? `type message · enter queues · enter on empty sends batch · up/down recall pending · alt-enter newline · @ artifacts · @@ sessions · ${paneFullscreen ? "esc pane" : "esc sessions"}`
                    : hasOutbox
                        ? `type message · enter queues behind durable items · up/down recall pending · alt-enter newline · @ artifacts · @@ sessions · ${paneFullscreen ? "esc pane" : "esc sessions"}`
                        : `type message · enter send · alt-enter newline · T themes · ? help · arrows move · alt-left/right word · alt-delete word · @ artifacts · @@ sessions · ${paneFullscreen ? "esc pane" : "esc sessions"}`,
    };

    let right = hints[focus] || hints[FOCUS_REGIONS.SESSIONS];
    // Surface the Stop-turn hint at the front (so truncation never eats it)
    // exactly while a turn is running; it stays listed, grayed, in `?` help.
    if (canStopSessionTurn(selectActiveSession(state))) {
        right = `ctrl-x stop · ${right}`;
    }
    return {
        left: state.ui.statusText,
        right,
    };
}

function flattenRunsLength(runs) {
    return (runs || []).reduce((sum, run) => sum + String(run?.text || "").length, 0);
}

function fitRuns(runs, maxWidth) {
    if (maxWidth <= 0) return [];
    const output = [];
    let remaining = maxWidth;

    for (const run of runs || []) {
        if (remaining <= 0) break;
        const text = String(run?.text || "");
        if (!text) continue;
        const chunk = text.length > remaining && remaining > 1
            ? `${text.slice(0, remaining - 1)}…`
            : text.slice(0, remaining);
        if (!chunk) continue;
        output.push({ ...run, text: chunk });
        remaining -= chunk.length;
    }

    return output;
}

function displayLength(value) {
    return Array.from(String(value || "")).length;
}

function fitDisplayText(value, maxWidth) {
    const text = String(value || "");
    if (maxWidth <= 0) return "";
    if (displayLength(text) <= maxWidth) return text;
    if (maxWidth === 1) return Array.from(text)[0] || "";
    return `${Array.from(text).slice(0, maxWidth - 1).join("")}…`;
}

function padDisplayText(value, width) {
    const text = fitDisplayText(value, width);
    const padding = Math.max(0, width - displayLength(text));
    return text + " ".repeat(padding);
}

function plainInspectorLine(text, color = "white", extra = {}) {
    return {
        text: String(text || ""),
        color,
        ...extra,
    };
}

function formatCompactBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "?";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** "12.4×" compression ratio (raw / stored); null when either is missing. */
function formatCompressionRatio(rawBytes, storedBytes) {
    const raw = Number(rawBytes);
    const stored = Number(storedBytes);
    if (!Number.isFinite(raw) || !Number.isFinite(stored) || raw <= 0 || stored <= 0) return null;
    const ratio = raw / stored;
    return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}×`;
}

function summarizeEventPreview(text, maxLength = 18) {
    const normalized = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return "";
    return displayLength(normalized) > maxLength
        ? `${Array.from(normalized).slice(0, Math.max(1, maxLength - 1)).join("")}…`
        : normalized;
}

function eventMessageText(event) {
    const data = event?.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
        if (typeof data.content === "string") return data.content;
        if (typeof data.text === "string") return data.text;
        if (typeof data.message === "string") return data.message;
        if (typeof data.question === "string") return data.question;
    }
    return "";
}

function joinUniqueSequenceDetail(parts = []) {
    const seen = new Set();
    const normalized = [];
    for (const part of parts) {
        const text = String(part || "").trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(text);
    }
    return normalized.join(" | ");
}

function formatDehydrateSequenceDetail(event, preview = "") {
    return joinUniqueSequenceDetail([
        event?.data?.reason === "cron_at" ? "cron" : event?.data?.reason,
        event?.data?.detail,
        event?.data?.message,
        event?.data?.error,
        preview,
    ]);
}

function formatLossyHandoffSequenceDetail(event, preview = "") {
    return joinUniqueSequenceDetail([
        event?.data?.message,
        event?.data?.detail,
        event?.data?.error,
        preview,
    ]);
}

function shortNodeLabel(nodeId) {
    const raw = String(nodeId || "").trim();
    if (!raw || raw === "(unknown)") return null;
    const tail = raw.split(/[/:]/).pop() || raw;
    const short = tail.length <= 5 ? tail : tail.slice(-5);
    return short.replace(/^[^a-zA-Z0-9]+/, "") || short;
}

const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
const RECENT_ACTIVITY_WINDOW_LABEL = "last 5m";

function getRecentActivityWindow(state) {
    let endMs = 0;

    for (const history of state.history.bySessionId.values()) {
        for (const event of history?.events || []) {
            const createdAtMs = event?.createdAt instanceof Date
                ? event.createdAt.getTime()
                : new Date(event?.createdAt || 0).getTime();
            if (Number.isFinite(createdAtMs)) {
                endMs = Math.max(endMs, createdAtMs);
            }
        }
    }

    if (!Number.isFinite(endMs) || endMs <= 0) {
        endMs = Date.now();
    }

    return {
        startMs: endMs - RECENT_ACTIVITY_WINDOW_MS,
        endMs,
        label: RECENT_ACTIVITY_WINDOW_LABEL,
    };
}

function entryFallsWithinWindow(entry, window) {
    if (!entry || !window) return false;
    const createdAtMs = Number(entry.createdAtMs || 0);
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs >= window.startMs && createdAtMs <= window.endMs;
}

function eventFallsWithinWindow(event, window) {
    if (!event || !window) return false;
    const createdAtMs = event?.createdAt instanceof Date
        ? event.createdAt.getTime()
        : new Date(event?.createdAt || 0).getTime();
    if (!Number.isFinite(createdAtMs)) return false;
    return createdAtMs >= window.startMs && createdAtMs <= window.endMs;
}

const SEQUENCE_ORCHESTRATOR_TYPES = new Set([
    "wait",
    "timer",
    "cron_start",
    "cron_fire",
    "cron_cancel",
    "spawn",
    "cmd_recv",
    "cmd_done",
]);

function isSequenceOrchestratorType(type) {
    return SEQUENCE_ORCHESTRATOR_TYPES.has(type);
}

function mapEventToSequenceEntry(event) {
    const time = formatTimestamp(event?.createdAt);
    const nodeLabel = shortNodeLabel(event?.workerNodeId);
    const detailText = eventMessageText(event);
    const preview = summarizeEventPreview(detailText, 20);
    const createdAtMs = event?.createdAt instanceof Date
        ? event.createdAt.getTime()
        : new Date(event?.createdAt || 0).getTime();
    const base = {
        time,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        nodeLabel,
        color: "white",
        detail: "",
        type: "other",
    };

    switch (event?.eventType) {
        case "session.turn_started":
            return { ...base, type: "turn_start", color: "gray", detail: `turn ${event?.data?.iteration ?? "?"}` };
        case "session.turn_completed": {
            const completedTurn = Number(event?.data?.turnIndex ?? event?.data?.iteration);
            return {
                ...base,
                type: "turn_end",
                color: "gray",
                detail: `turn ${event?.data?.iteration ?? "?"} done`,
                // Structural turn marker: renderers must not infer the turn
                // from `detail`, which gets width-truncated in narrow columns.
                ...(Number.isFinite(completedTurn) ? { completedTurn } : {}),
            };
        }
        case "user.message":
            return { ...base, type: "user_msg", color: "white", detail: preview ? `>> ${preview}` : ">> user" };
        case "assistant.message":
            return { ...base, type: "response", color: "green", detail: preview ? `< ${preview}` : "< response" };
        case "system.message":
            return { ...base, type: "system", color: "yellow", detail: preview || "system" };
        case "session.wait_started":
            return {
                ...base,
                type: "wait",
                color: "yellow",
                detail: `wait ${formatHumanDurationSeconds(event?.data?.seconds ?? 0)}`,
            };
        case "session.wait_completed":
            return {
                ...base,
                type: "timer",
                color: "yellow",
                detail: `${formatHumanDurationSeconds(event?.data?.seconds ?? 0)} up`,
            };
        case "session.lossy_handoff": {
            const detail = formatLossyHandoffSequenceDetail(event, preview);
            return {
                ...base,
                type: "dehydrate",
                color: "yellow",
                detail: detail ? `lossy ${detail}` : "lossy handoff",
            };
        }
        case "session.dehydrated":
            return {
                ...base,
                type: "dehydrate",
                color: "cyan",
                detail: `ZZ ${formatDehydrateSequenceDetail(event, preview)}`.trim(),
            };
        case "session.rehydrated":
        case "session.hydrated":
            return { ...base, type: "hydrate", color: "green", detail: "rehydrated" };
        case "session.agent_spawned":
            return {
                ...base,
                type: "spawn",
                color: "cyan",
                detail: `spawn ${event?.data?.agentId || shortSessionId(event?.data?.childSessionId) || "agent"}`,
            };
        case "session.cron_started":
            return {
                ...base,
                type: "cron_start",
                color: "magenta",
                detail: `cron ${formatHumanDurationSeconds(event?.data?.intervalSeconds ?? 0)}`,
            };
        case "session.cron_at_scheduled":
        case "session.cron_at_started":
            return {
                ...base,
                type: "cron_start",
                color: "magenta",
                detail: `cron ${formatCronTimestampForClient(event?.data?.nextFireAtMs ?? event?.data?.nextFireAt)}`,
            };
        case "session.cron_fired":
            return { ...base, type: "cron_fire", color: "magenta", detail: "cron fired" };
        case "session.cron_at_fired":
            return {
                ...base,
                type: "cron_fire",
                color: "magenta",
                detail: `cron fired ${formatCronTimestampForClient(event?.data?.scheduledAt)}`,
            };
        case "session.cron_cancelled":
        case "session.cron_at_cancelled":
            return { ...base, type: "cron_cancel", color: "magenta", detail: "cron off" };
        case "session.cron_at_completed":
            return { ...base, type: "cron_cancel", color: "magenta", detail: "cron done" };
        case "session.command_received":
            return {
                ...base,
                type: "cmd_recv",
                color: "magenta",
                detail: `/${event?.data?.cmd || "?"}`,
            };
        case "session.command_completed":
            return {
                ...base,
                type: "cmd_done",
                color: "magenta",
                detail: `/${event?.data?.cmd || "?"} ok`,
            };
        case "session.compaction_start":
            return { ...base, type: "compaction", color: "gray", detail: "compaction…" };
        case "session.compaction_complete":
            return { ...base, type: "compaction", color: "gray", detail: "compacted" };
        case "session.error":
            return { ...base, type: "error", color: "red", detail: preview || "error" };
        default:
            return null;
    }
}

function buildSequenceEntries(events = []) {
    const entries = [];

    for (const event of events || []) {
        const entry = mapEventToSequenceEntry(event);
        if (!entry) continue;

        entries.push({
            ...entry,
            nodeLabel: isSequenceOrchestratorType(entry.type)
                ? "orch"
                : (entry.nodeLabel || "orch"),
        });
    }

    return entries;
}

function collapseContiguousSpawnEntries(entries = []) {
    const collapsed = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry?.type !== "spawn" || entry?.nodeLabel !== "orch") {
            collapsed.push(entry);
            continue;
        }

        let runLength = 1;
        while (index + runLength < entries.length) {
            const nextEntry = entries[index + runLength];
            if (nextEntry?.type !== "spawn" || nextEntry?.nodeLabel !== "orch") break;
            if (nextEntry?.time !== entry.time) break;
            runLength += 1;
        }

        if (runLength === 1) {
            collapsed.push(entry);
            continue;
        }

        collapsed.push({
            ...entry,
            detail: `spawn x${runLength}`,
        });
        index += runLength - 1;
    }

    return collapsed;
}

function buildSessionStatusSequenceEntry(session) {
    const errorText = String(session?.error || "").trim();
    if (!errorText) return null;

    const errorKind = getSessionErrorVisualKind(session);
    if (!errorKind) return null;

    const createdAtMs = session?.updatedAt ? Number(session.updatedAt) : Date.now();
    const safeCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();

    return {
        time: formatTimestamp(safeCreatedAtMs),
        createdAtMs: safeCreatedAtMs,
        nodeLabel: "orch",
        color: errorKind === "failed" ? "red" : "yellow",
        detail: `${errorKind === "failed" ? "ERR" : "WARN"} ${summarizeEventPreview(errorText, 20) || (errorKind === "failed" ? "error" : "warning")}`,
        type: errorKind === "failed" ? "error" : "warning",
    };
}

function appendCurrentSessionStatusEntry(entries, session) {
    const statusEntry = buildSessionStatusSequenceEntry(session);
    if (!statusEntry) return entries;

    const hasEquivalentEntry = (entries || []).some((entry) => {
        if (!entry || entry.nodeLabel !== "orch") return false;
        if (entry.detail !== statusEntry.detail) return false;
        return Math.abs(Number(entry.createdAtMs || 0) - statusEntry.createdAtMs) <= 60_000;
    });
    if (hasEquivalentEntry) return entries;

    return [...(entries || []), statusEntry];
}

function buildSequenceNodeUnionForWindow(state, startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return [];
    }

    const labels = new Set();

    for (const history of state.history.bySessionId.values()) {
        const entries = buildSequenceEntries(history?.events || []);
        for (const entry of entries) {
            if (!entry?.nodeLabel || entry.nodeLabel === "orch") continue;
            const createdAtMs = Number(entry.createdAtMs || 0);
            if (!Number.isFinite(createdAtMs)) continue;
            if (createdAtMs < startMs || createdAtMs > endMs) continue;
            labels.add(entry.nodeLabel);
        }
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function buildNodeMapNodeUnionForWindow(state, window) {
    const labels = new Set();

    for (const history of state.history.bySessionId.values()) {
        for (const event of history?.events || []) {
            if (!eventFallsWithinWindow(event, window)) continue;
            const nodeLabel = shortNodeLabel(event?.workerNodeId);
            if (!nodeLabel) continue;
            labels.add(nodeLabel);
        }
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function buildSequenceHeaderLine(nodeLabels, timeWidth, colWidth) {
    const runs = [
        { text: padDisplayText("TIME", timeWidth), color: "white", bold: true },
        { text: " ", color: null },
    ];
    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        runs.push({ text: padDisplayText(nodeLabel, colWidth), color: "white", bold: true });
    });
    return runs;
}

function buildSequenceDividerLine(nodeLabels, timeWidth, colWidth) {
    return plainInspectorLine(
        `${"-".repeat(timeWidth)} ${nodeLabels.map(() => "─".repeat(colWidth)).join(" ")}`,
        "gray",
    );
}

function buildSequenceStatsLines(state, session, maxWidth) {
    const statsEntry = state?.orchestration?.bySessionId?.[session?.sessionId] || null;
    let body = "loading orchestration stats...";
    if (!statsEntry) {
    } else if (statsEntry.loading && !statsEntry.stats) {
        body = "loading orchestration stats...";
    } else if (!statsEntry.stats) {
        body = "orchestration stats unavailable";
    } else {
        const stats = statsEntry.stats;
        const fullParts = [];
        const compactParts = [];
        if (typeof stats.orchestrationVersion === "string" && stats.orchestrationVersion) {
            fullParts.push(`v ${stats.orchestrationVersion}`);
            compactParts.push(`v${stats.orchestrationVersion}`);
        }
        if (stats.historyEventCount != null) {
            fullParts.push(`hist ${Number(stats.historyEventCount) || 0} ev`);
            compactParts.push(`h${Number(stats.historyEventCount) || 0}`);
        }
        if (stats.historySizeBytes != null) {
            const formatted = formatCompactBytes(stats.historySizeBytes);
            fullParts.push(formatted);
            compactParts.push(formatted);
        }
        if (stats.queuePendingCount != null) {
            fullParts.push(`q ${Number(stats.queuePendingCount) || 0}`);
            compactParts.push(`q${Number(stats.queuePendingCount) || 0}`);
        }
        if (stats.kvUserKeyCount != null) {
            fullParts.push(`kv ${Number(stats.kvUserKeyCount) || 0} keys`);
            compactParts.push(`kv${Number(stats.kvUserKeyCount) || 0}`);
        }
        if (stats.kvTotalValueBytes != null) {
            fullParts.push(formatCompactBytes(stats.kvTotalValueBytes));
        }
        body = maxWidth <= 40 ? compactParts.join(" · ") : fullParts.join(" | ");
        if (!body) body = "orchestration stats unavailable";
    }

    if (maxWidth <= 52) {
        return [fitRuns([
            { text: "Stats ", color: "cyan", bold: true },
            { text: body, color: "white" },
        ], Math.max(18, maxWidth))];
    }

    return buildMessageCardLines({
        title: "Stats",
        body,
        width: Math.max(24, maxWidth),
        titleColor: "cyan",
        borderColor: "gray",
        fitToContent: true,
    }).slice(0, -1);
}

function buildSequenceEventLine(entry, nodeLabels, timeWidth, colWidth) {
    const targetNode = nodeLabels.includes(entry.nodeLabel)
        ? entry.nodeLabel
        : (nodeLabels.includes("…") ? "…" : nodeLabels[nodeLabels.length - 1]);
    const runs = [
        { text: padDisplayText(entry.time || "", timeWidth), color: "white" },
        { text: " ", color: null },
    ];

    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        if (nodeLabel === targetNode) {
            runs.push({
                text: padDisplayText(entry.detail || "", colWidth),
                color: entry.color || "white",
                bold: Boolean(entry.bold),
                underline: Boolean(entry.underline),
                ...(entry.completedTurn != null ? { completedTurn: entry.completedTurn } : {}),
            });
        } else {
            runs.push({
                text: padDisplayText("│", colWidth),
                color: "gray",
            });
        }
    });

    return runs;
}

function buildNodeMapHeaderLine(nodeLabels, colWidth) {
    const runs = [];
    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        runs.push({ text: padDisplayText(nodeLabel, colWidth), color: "white", bold: true });
    });
    return runs;
}

const SEQ_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "minimal", "none"]);

function shortModelForSequence(value) {
    const model = String(value || "").trim();
    if (!model) return "unknown";
    const parts = model.split(":").filter(Boolean);
    if (parts.length === 0) return "unknown";
    const last = String(parts[parts.length - 1]).toLowerCase();
    const index = parts.length > 1 && SEQ_REASONING_EFFORTS.has(last) ? parts.length - 2 : parts.length - 1;
    return parts[Math.max(0, index)] || parts[0] || "unknown";
}

function formatTokenCountK(value) {
    const tokens = Number(value || 0);
    if (!Number.isFinite(tokens)) return "?K";
    const scaled = tokens / 1000;
    return `${scaled.toFixed(Math.abs(scaled) >= 10 ? 1 : 2)}K`;
}

function formatSeqCount(value) {
    return Number(value || 0).toLocaleString("en-US");
}

// Turn index -> turn_completed event data, mirroring the portal's per-turn
// completion model so the TUI sequence tab can show the same detail.
export function buildSequenceCompletionByTurn(events) {
    const map = new Map();
    for (const event of events || []) {
        if (event?.eventType !== "session.turn_completed") continue;
        const turn = Number(event?.data?.turnIndex ?? event?.data?.iteration);
        if (!Number.isFinite(turn)) continue;
        map.set(turn, event.data || {});
    }
    return map;
}

// The magenta "Mod: ..." divider (+ optional detail lines) inserted under a
// completed-turn row when the TUI sequence tab is showing turn expansion.
function buildSequenceTurnLines(data, { expanded, selected, maxWidth }) {
    const caret = expanded ? "v" : ">";
    const model = shortModelForSequence(data?.model);
    const dur = data?.durationMs != null ? `${(Number(data.durationMs) / 1000).toFixed(1)}s` : "n/a";
    const dividerText = `${caret} Mod: ${model}  tok ${formatTokenCountK(data?.tokensInput)}/${formatTokenCountK(data?.tokensOutput)}  dur ${dur}`;
    const lines = [];
    if (selected) {
        lines.push(buildActiveHighlightLine(padDisplayText(dividerText, Math.max(18, maxWidth))));
    } else {
        lines.push([{ text: dividerText, color: "magenta" }]);
    }
    if (expanded) {
        const details = [
            ["model", data?.reasoningEffort ? `${data?.model || "(unknown)"}:${data.reasoningEffort}` : (data?.model || "(unknown)")],
            ["duration", data?.durationMs != null ? `${formatSeqCount(data.durationMs)} ms` : null],
            ["tokens", `${formatSeqCount(data?.tokensInput)} in / ${formatSeqCount(data?.tokensOutput)} out`],
            ["cache", `${formatSeqCount(data?.tokensCacheRead)} read / ${formatSeqCount(data?.tokensCacheWrite)} write`],
            ["tools", `${formatSeqCount(data?.toolCalls)} calls / ${formatSeqCount(data?.toolErrors)} errors`],
            ["names", Array.isArray(data?.toolNames) && data.toolNames.length ? data.toolNames.join(", ") : null],
            ["worker", data?.workerNodeId || null],
            ["result", data?.resultType || null],
            ["error", data?.errorMessage || null],
        ].filter(([, value]) => value != null && value !== "");
        for (const [label, value] of details) {
            lines.push([
                { text: `      ${label}: `, color: "gray" },
                { text: String(value), color: "white" },
            ]);
        }
    }
    return lines;
}

function buildSequenceViewForSession(state, session, maxWidth, options = {}) {
    const allowWideColumns = Boolean(options?.allowWideColumns);
    const statsLines = buildSequenceStatsLines(state, session, maxWidth);
    const history = state.history.bySessionId.get(session.sessionId);
    const entries = appendCurrentSessionStatusEntry(
        collapseContiguousSpawnEntries(buildSequenceEntries(history?.events || [])),
        session,
    );
    if (entries.length === 0) {
        return {
            stickyLines: statsLines,
            lines: [plainInspectorLine("No events yet - interact with this session to populate the sequence diagram.")],
        };
    }

    const recentWindow = getRecentActivityWindow(state);
    const windowedEntries = entries.filter((entry) => entryFallsWithinWindow(entry, recentWindow));
    const visibleEntries = (windowedEntries.length > 0 ? windowedEntries : entries).slice(-48);
    const unionNodes = buildSequenceNodeUnionForWindow(state, recentWindow.startMs, recentWindow.endMs);
    const activeSessionNodes = Array.from(new Set(visibleEntries
        .map((entry) => entry.nodeLabel)
        .filter((nodeLabel) => nodeLabel && nodeLabel !== "orch"))).sort((left, right) => left.localeCompare(right));
    const uniqueNodes = unionNodes.length > 0 ? unionNodes : activeSessionNodes;
    const timeWidth = 8;
    const availableWidth = Math.max(18, maxWidth);
    const maxNodes = Math.max(1, Math.floor((availableWidth - timeWidth - 1) / 6));
    let nodeLabels = ["orch", ...uniqueNodes];
    if (!allowWideColumns && nodeLabels.length > maxNodes) {
        const visibleCount = Math.max(1, maxNodes - 1);
        nodeLabels = [
            ...nodeLabels.slice(0, visibleCount),
            "…",
        ];
    }

    const gapWidth = Math.max(0, nodeLabels.length - 1);
    const colWidth = Math.max(
        4,
        Math.floor((availableWidth - timeWidth - 1 - gapWidth) / Math.max(1, nodeLabels.length)),
    );

    const expansion = options?.sequenceExpansion || null;
    const completionByTurn = expansion ? buildSequenceCompletionByTurn(history?.events || []) : null;
    const expandedTurns = expansion ? new Set((expansion.expandedTurns || []).map(Number)) : null;
    const selectedTurn = expansion && expansion.selectedTurn != null ? Number(expansion.selectedTurn) : null;

    const lines = [];
    for (const entry of visibleEntries) {
        lines.push(buildSequenceEventLine(entry, nodeLabels, timeWidth, colWidth));
        if (expansion && entry.completedTurn != null) {
            const turn = Number(entry.completedTurn);
            const data = completionByTurn.get(turn);
            if (data) {
                for (const detailLine of buildSequenceTurnLines(data, {
                    expanded: expandedTurns.has(turn),
                    selected: selectedTurn === turn,
                    maxWidth: availableWidth,
                })) {
                    lines.push(detailLine);
                }
            }
        }
    }

    return {
        stickyLines: [
            ...statsLines,
            plainInspectorLine(`Window: ${recentWindow.label}`, "gray"),
            buildSequenceHeaderLine(nodeLabels, timeWidth, colWidth),
            buildSequenceDividerLine(nodeLabels, timeWidth, colWidth),
        ],
        lines,
    };
}

function buildOrderedSessionIds(state) {
    const orderedIds = [];
    const seen = new Set();

    for (const entry of state.sessions.flat || []) {
        if (!entry?.sessionId || seen.has(entry.sessionId)) continue;
        seen.add(entry.sessionId);
        orderedIds.push(entry.sessionId);
    }

    for (const sessionId of Object.keys(state.sessions.byId || {})) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        orderedIds.push(sessionId);
    }

    return orderedIds;
}

function getLastKnownSessionNode(history, window = null) {
    const events = history?.events || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (window && !eventFallsWithinWindow(events[index], window)) continue;
        const nodeLabel = shortNodeLabel(events[index]?.workerNodeId);
        if (nodeLabel) return nodeLabel;
    }
    return null;
}

function buildNodeMapCell(session, brandingTitle, width, active) {
    const label = width >= 16
        ? (session?.isSystem
            ? canonicalSystemTitle(session, brandingTitle)
            : (session?.title || shortSessionId(session?.sessionId)))
        : shortSessionId(session?.sessionId);
    const prefix = session?.isSystem ? "⚙ " : `${sessionStatusIcon(session) || "."} `;
    const text = padDisplayText(`${prefix}${label}`, width);

    if (active) {
        return buildActiveHighlightLine(text);
    }

    return {
        text,
        color: session?.isSystem ? "yellow" : sessionStatusColor(session),
        bold: Boolean(session?.isSystem),
    };
}

function buildNodeMapLines(state, maxWidth, options = {}) {
    const allowWideColumns = Boolean(options?.allowWideColumns);
    const orderedSessionIds = buildOrderedSessionIds(state);
    if (orderedSessionIds.length === 0) {
        return [plainInspectorLine("No sessions available for the node map.", "gray")];
    }

    const recentWindow = getRecentActivityWindow(state);
    const nodeSessionMap = new Map();
    const knownNodes = buildNodeMapNodeUnionForWindow(state, recentWindow);
    let missingHistoryCount = 0;
    let inWindowSessionCount = 0;

    for (const sessionId of orderedSessionIds) {
        const session = state.sessions.byId[sessionId];
        if (!session) continue;
        const history = state.history.bySessionId.get(sessionId);
        if (!history?.events) missingHistoryCount += 1;
        const nodeLabel = getLastKnownSessionNode(history, recentWindow);
        if (!nodeLabel || !knownNodes.includes(nodeLabel)) continue;
        inWindowSessionCount += 1;
        if (!nodeSessionMap.has(nodeLabel)) {
            nodeSessionMap.set(nodeLabel, []);
        }
        nodeSessionMap.get(nodeLabel).push(session);
    }

    if (knownNodes.length === 0) {
        return [plainInspectorLine(`No worker activity in the ${recentWindow.label} window.`, "gray")];
    }

    const availableWidth = Math.max(18, maxWidth);
    const maxColumns = Math.max(1, Math.floor((availableWidth + 1) / 10));
    let nodeLabels = knownNodes;
    if (!allowWideColumns && knownNodes.length > maxColumns) {
        const visibleCount = Math.max(0, maxColumns - 1);
        const overflowSessions = [];
        const visibleLabels = knownNodes.slice(0, visibleCount);
        for (const hiddenLabel of knownNodes.slice(visibleCount)) {
            overflowSessions.push(...(nodeSessionMap.get(hiddenLabel) || []));
        }
        nodeSessionMap.set("…", overflowSessions);
        nodeLabels = [...visibleLabels, "…"];
    }

    const gapWidth = Math.max(0, nodeLabels.length - 1);
    const colWidth = Math.max(8, Math.floor((availableWidth - gapWidth) / Math.max(1, nodeLabels.length)));
    const maxRows = nodeLabels.reduce(
        (max, nodeLabel) => Math.max(max, (nodeSessionMap.get(nodeLabel) || []).length),
        0,
    );

    const lines = [
        plainInspectorLine(`Window: ${recentWindow.label}`, "gray"),
        buildNodeMapHeaderLine(nodeLabels, colWidth),
        plainInspectorLine(nodeLabels.map(() => "─".repeat(colWidth)).join(" "), "gray"),
    ];

    for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
        const rowRuns = [];
        nodeLabels.forEach((nodeLabel, columnIndex) => {
            if (columnIndex > 0) rowRuns.push({ text: " ", color: null });
            const session = (nodeSessionMap.get(nodeLabel) || [])[rowIndex];
            if (!session) {
                rowRuns.push({ text: " ".repeat(colWidth), color: null });
                return;
            }
            rowRuns.push(buildNodeMapCell(
                session,
                state.branding?.title || "PilotSwarm",
                colWidth,
                session.sessionId === state.sessions.activeSessionId,
            ));
        });
        lines.push(rowRuns);
    }

    if (missingHistoryCount > 0) {
        lines.push(plainInspectorLine("", "gray"));
        lines.push(plainInspectorLine(`Loading worker history for ${missingHistoryCount} session(s)…`, "gray"));
    }
    if (inWindowSessionCount === 0) {
        lines.push(plainInspectorLine("", "gray"));
        lines.push(plainInspectorLine(`No sessions mapped onto worker nodes in the ${recentWindow.label} window.`, "gray"));
    }

    return lines;
}

export function selectModelPickerModal(state, maxWidth = 72) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "modelPicker") return null;

    const groups = Array.isArray(modal.groups) ? modal.groups : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);
    const rows = [];
    const rowItemIndexes = [];
    let selectedRowIndex = 0;

    for (const group of groups) {
        const headerRuns = fitRuns([
            { text: `${group.providerId}`, color: "cyan", bold: true },
            { text: ` (${group.providerType || "provider"})`, color: "gray" },
        ], contentWidth);
        rows.push(headerRuns);
        rowItemIndexes.push(null);

        for (const model of group.models || []) {
            const itemIndex = Array.isArray(modal.items)
                ? modal.items.findIndex((item) => item.id === model.id)
                : -1;
            const isSelected = itemIndex === selectedIndex;
            const labelRuns = fitRuns([
                { text: "· ", color: "gray" },
                { text: model.modelName || model.qualifiedName || model.id, color: "white", bold: Boolean(model.isDefault) },
                ...(model.cost ? [{ text: ` [${model.cost}]`, color: "gray" }] : []),
                ...(model.isDefault ? [{ text: " ← current default", color: "gray" }] : []),
            ], contentWidth);

            const line = isSelected
                ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
                : labelRuns;

            if (isSelected) selectedRowIndex = rows.length;
            rows.push(line);
            rowItemIndexes.push(itemIndex >= 0 ? itemIndex : null);
        }
    }

    const selectedItem = Array.isArray(modal.items) ? modal.items[selectedIndex] || null : null;
    const supportedReasoning = Array.isArray(selectedItem?.supportedReasoningEfforts)
        ? selectedItem.supportedReasoningEfforts.filter(Boolean)
        : [];
    const defaultReasoning = typeof selectedItem?.defaultReasoningEffort === "string"
        ? selectedItem.defaultReasoningEffort
        : null;
    const detailsLines = selectedItem
        ? [
            [{
                text: selectedItem.modelName || selectedItem.qualifiedName || selectedItem.id,
                color: "white",
                bold: true,
            }],
            [{
                text: `${selectedItem.providerId} (${selectedItem.providerType || "provider"})`,
                color: "gray",
            }],
            ...(selectedItem.cost ? [[{ text: `Cost: ${selectedItem.cost}`, color: "gray" }]] : []),
            ...(supportedReasoning.length > 0
                ? [[{ text: `Reasoning: ${supportedReasoning.join(", ")}`, color: "gray" }]]
                : []),
            ...(defaultReasoning ? [[{ text: `Default reasoning: ${defaultReasoning}`, color: "gray" }]] : []),
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.description || "No description available for this model.",
                color: selectedItem.description ? "white" : "gray",
            }],
        ]
        : [[{ text: "No model selected.", color: "gray" }]];

    return {
        title: modal.title || "Select model for new session",
        rows,
        rowItemIndexes,
        selectedRowIndex,
        detailsTitle: "Model Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                46,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectSessionAgentPickerModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "sessionAgentPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);
    const rows = items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const labelRuns = fitRuns([
            { text: item?.kind === "generic" ? "○ " : "· ", color: "gray" },
            { text: item?.title || item?.agentName || item?.id || "Agent", color: "white", bold: true },
            ...(item?.kind === "generic"
                ? [{ text: " [generic]", color: "gray" }]
                : [{ text: ` (${item?.agentName || item?.id || "agent"})`, color: "gray" }]),
        ], contentWidth);
        return isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns;
    });

    const selectedItem = items[selectedIndex] || null;
    const selectedModel = modal.sessionOptions?.model || null;
    const selectedReasoningEffort = modal.sessionOptions?.reasoningEffort || null;
    const detailsLines = selectedItem
        ? [
            [{
                text: selectedItem.title || selectedItem.agentName || selectedItem.id || "Agent",
                color: "white",
                bold: true,
            }],
            ...(selectedItem.kind === "generic"
                ? [[{ text: "Open-ended session", color: "gray" }]]
                : [[{ text: selectedItem.agentName || selectedItem.id || "agent", color: "gray" }]]),
            ...(selectedModel ? [[{ text: `Model: ${selectedModel}`, color: "gray" }]] : []),
            ...(selectedReasoningEffort ? [[{ text: `Reasoning: ${selectedReasoningEffort}`, color: "gray" }]] : []),
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.description || (
                    selectedItem.kind === "generic"
                        ? "Create a general-purpose session without a specialized named agent."
                        : "No description available for this agent."
                ),
                color: selectedItem.description ? "white" : "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: selectedItem.tools?.length
                    ? `Tools: ${selectedItem.tools.join(", ")}`
                    : "Tools: system defaults only",
                color: "gray",
            }],
        ]
        : [[{ text: "No agent selected.", color: "gray" }]];

    return {
        title: modal.title || "Select agent for new session",
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Agent Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                52,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectReasoningEffortPickerModal(state, maxWidth = 64) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "reasoningEffortPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);

    const rows = items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const labelRuns = fitRuns([
            { text: "· ", color: "gray" },
            { text: String(item?.label || item?.id || "effort"), color: "white", bold: true },
            ...(item?.isDefault ? [{ text: " ← model default", color: "gray" }] : []),
        ], contentWidth);
        return isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns;
    });

    const selectedItem = items[selectedIndex] || null;
    const modelItem = modal.modelItem || null;
    const detailsLines = [
        [{ text: modelItem?.modelName || modelItem?.qualifiedName || "Selected model", color: "white", bold: true }],
        [{ text: `${modelItem?.providerId || "provider"} (${modelItem?.providerType || "provider"})`, color: "gray" }],
        [{ text: "", color: "gray" }],
        [{ text: selectedItem?.id ? `Using reasoning effort: ${selectedItem.id}` : "Choose an effort.", color: "white" }],
    ];

    return {
        title: modal.title || "Select reasoning effort",
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Reasoning Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                46,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectContextTierPickerModal(state, maxWidth = 64) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "contextTierPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);

    const rows = items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const labelRuns = fitRuns([
            { text: "· ", color: "gray" },
            { text: String(item?.label || item?.id || "tier"), color: "white", bold: true },
            ...(item?.isDefault ? [{ text: " ← model default", color: "gray" }] : []),
        ], contentWidth);
        return isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns;
    });

    const selectedItem = items[selectedIndex] || null;
    const modelItem = modal.modelItem || null;
    const detailsLines = [
        [{ text: modelItem?.modelName || modelItem?.qualifiedName || "Selected model", color: "white", bold: true }],
        [{ text: `${modelItem?.providerId || "provider"} (${modelItem?.providerType || "provider"})`, color: "gray" }],
        [{ text: "", color: "gray" }],
        [{ text: selectedItem?.id ? `Using context window: ${selectedItem.id}` : "Choose a context window.", color: "white" }],
        [{ text: "Long context costs more per token.", color: "gray" }],
    ];

    return {
        title: modal.title || "Select context window",
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Context Window",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                46,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectSessionGroupPickerModal(state, maxWidth = 72) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "sessionGroupPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(24, maxWidth - 4);
    const sessionCount = Array.isArray(modal.sessionIds) ? modal.sessionIds.length : 0;

    const rows = items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const marker = item?.kind === "noGroup" ? "○ " : item?.kind === "newGroup" ? "+ " : "🗂  ";
        const labelRuns = fitRuns([
            { text: marker, color: item?.kind === "group" ? "cyan" : "gray", bold: item?.kind !== "noGroup" },
            { text: item?.label || item?.groupId || "Group", color: "white", bold: true },
            ...(item?.kind === "group" ? [{ text: ` (${item.memberCount ?? 0})`, color: "gray" }] : []),
        ], contentWidth);
        return isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns;
    });

    const selectedItem = items[selectedIndex] || null;
    const detailsLines = selectedItem
        ? [
            [{ text: selectedItem.label || selectedItem.groupId || "Group", color: "white", bold: true }],
            [{ text: `${sessionCount} session${sessionCount === 1 ? "" : "s"} selected`, color: "gray" }],
            ...(selectedItem.kind === "group"
                ? [[{ text: `${selectedItem.memberCount ?? 0} current member${selectedItem.memberCount === 1 ? "" : "s"}`, color: "gray" }]]
                : []),
            [{ text: "", color: "gray" }],
            [{ text: selectedItem.description || "Move selected session(s) to this group.", color: "white" }],
        ]
        : [[{ text: "No group selected.", color: "gray" }]];

    return {
        title: modal.title || "Move to Group",
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Move Details",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                50,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

export function selectRenameSessionModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "renameSession") return null;

    const value = String(modal.value || "");
    const agentTitlePrefix = typeof modal.agentTitlePrefix === "string" && modal.agentTitlePrefix.trim()
        ? modal.agentTitlePrefix.trim()
        : null;
    const currentTitle = String(modal.currentTitle || "").trim();
    const previewTitle = value.trim()
        ? (agentTitlePrefix ? `${agentTitlePrefix}: ${value.trim()}` : value.trim())
        : (agentTitlePrefix ? `${agentTitlePrefix}: …` : "…");

    const detailsLines = [
        [{
            text: "Current: ",
            color: "gray",
        }, {
            text: currentTitle || "(untitled session)",
            color: currentTitle ? "white" : "gray",
        }],
        [{
            text: "Saved as: ",
            color: "gray",
        }, {
            text: previewTitle,
            color: "white",
            bold: true,
        }],
        ...(agentTitlePrefix
            ? [[{
                text: "Named-agent prefix stays fixed.",
                color: "gray",
            }]]
            : []),
    ];

    return {
        title: modal.title || "Rename Session",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: agentTitlePrefix
            ? "Type the title after the fixed agent name"
            : "Type a session title",
        helpTitle: "Rename Rules",
        helpLines: [
            [{
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " save  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "Manual titles stop future automatic LLM title changes for this session.",
                color: "gray",
            }],
        ],
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                56,
                displayLength(currentTitle || "(untitled session)") + 18,
                displayLength(previewTitle) + 18,
            ),
            maxWidth,
        ),
    };
}

export function selectSessionGroupNameModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "sessionGroupName") return null;

    const value = String(modal.value || "");
    const sessionCount = Array.isArray(modal.sessionIds) ? modal.sessionIds.length : 0;
    const previewTitle = value.trim() || "…";
    return {
        title: modal.title || "New Group",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: "Type a group name",
        helpTitle: "Group Name",
        helpLines: [
            [
                { text: "Enter", color: "cyan", bold: true },
                { text: " create and move  ", color: "gray" },
                { text: "Esc", color: "cyan", bold: true },
                { text: " cancel", color: "gray" },
            ],
            [{ text: "", color: "gray" }],
            [{ text: `The new group will contain ${sessionCount} selected session${sessionCount === 1 ? "" : "s"}.`, color: "gray" }],
        ],
        detailsLines: [
            [{ text: "New group: ", color: "gray" }, { text: previewTitle, color: "white", bold: true }],
            [{ text: "Groups are containers only; session actions remain per-session.", color: "gray" }],
        ],
        idealWidth: Math.min(Math.max(56, displayLength(previewTitle) + 18), maxWidth),
    };
}

export function selectArtifactUploadModal(state, maxWidth = 82) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "artifactUpload") return null;

    const value = String(modal.value || "");
    const sessionId = modal.sessionId || state.ui.promptAttachments?.[0]?.sessionId || state.sessions?.activeSessionId || null;
    const targetSession = sessionId ? state.sessions?.byId?.[sessionId] || null : null;
    const targetLabel = sessionId
        ? (targetSession ? buildSessionTitle(targetSession, state.branding?.title) : shortSessionId(sessionId))
        : "A new session will be created on upload";

    const detailsLines = [
        [{
            text: "Target: ",
            color: "gray",
        }, {
            text: targetLabel,
            color: sessionId ? "white" : "gray",
            bold: Boolean(sessionId),
        }],
    ];

    return {
        title: modal.title || "Upload Artifact",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: "~/path/to/file.md",
        helpTitle: "Upload Rules",
        helpLines: [
            [{
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " upload  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "The file is uploaded into this session's artifact store immediately.",
                color: "gray",
            }],
            [{
                text: "Use the files browser or @-driven browsing in the prompt to reference it after upload.",
                color: "gray",
            }],
        ],
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                60,
                displayLength(value || "~/path/to/file.md") + 20,
                displayLength(targetLabel) + 20,
            ),
            maxWidth,
        ),
    };
}

function buildFilterModalPresentation(modal, currentValues = {}, maxWidth = 96, fallbackTitle = "Filters", fallbackDescription = "Choose how this pane is filtered and rendered.") {
    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const selectedItem = items[selectedIndex] || null;
    const panes = items.map((item, index) => {
        const currentValue = currentValues?.[item.id] || item.options?.[0]?.id;
        const lines = (item.options || []).map((option) => (option.id === currentValue
            ? buildActiveHighlightLine(option.label)
            : {
                text: option.label,
                color: "white",
            }));

        return {
            id: item.id,
            title: item.label,
            focused: index === selectedIndex,
            description: item.description || "",
            lines: lines.length > 0
                ? lines
                : [{ text: "No options available.", color: "gray" }],
            idealWidth: Math.max(
                20,
                String(item.label || "").length + 4,
                ...(item.options || []).map((option) => String(option?.label || "").length + 4),
            ),
        };
    });

    return {
        title: modal.title || fallbackTitle,
        panes,
        helpTitle: selectedItem?.label || fallbackTitle,
        helpLines: [
            [{
                text: selectedItem?.description || fallbackDescription,
                color: "white",
            }],
            [{ text: "", color: "gray" }],
            [{
                text: "Tab/Shift-Tab",
                color: "cyan",
                bold: true,
            }, {
                text: " switch filter  ",
                color: "gray",
            }, {
                text: "Up/Down",
                color: "cyan",
                bold: true,
            }, {
                text: " change value  ",
                color: "gray",
            }, {
                text: "Enter",
                color: "cyan",
                bold: true,
            }, {
                text: " close  ",
                color: "gray",
            }, {
                text: "Esc",
                color: "cyan",
                bold: true,
            }, {
                text: " cancel",
                color: "gray",
            }],
        ],
        footerRuns: [
            { text: "Tab/Shift-Tab", color: "cyan", bold: true },
            { text: " switch filter · ", color: "gray" },
            { text: "Up/Down", color: "cyan", bold: true },
            { text: " change value · ", color: "gray" },
            { text: "Enter", color: "cyan", bold: true },
            { text: " close · ", color: "gray" },
            { text: "Esc", color: "cyan", bold: true },
            { text: " cancel", color: "gray" },
        ],
        idealWidth: Math.min(
            Math.max(
                72,
                panes.reduce((sum, pane) => sum + pane.idealWidth, 0) + Math.max(0, panes.length - 1) * 2 + 4,
            ),
            maxWidth,
        ),
    };
}

function isOwnerFilterItemSelected(item, ownerFilter = {}, auth = {}) {
    if (!item) return false;
    if (item.kind === "all") return ownerFilter?.all === true;
    if (ownerFilter?.all === true) return false;
    if (item.kind === "system") return ownerFilter?.includeSystem === true;
    if (item.kind === "unowned") return ownerFilter?.includeUnowned === true;
    if (item.kind === "me") return ownerFilter?.includeMe === true && Boolean(ownerKeyForOwner(auth?.principal));
    if (item.kind === "owner") return Array.isArray(ownerFilter?.ownerKeys) && ownerFilter.ownerKeys.includes(item.ownerKey);
    return false;
}

function summarizeOwnerFilter(items = [], ownerFilter = {}, auth = {}) {
    if (ownerFilter?.all === true) return "All sessions";
    const selected = items
        .filter((item) => item?.kind !== "all" && isOwnerFilterItemSelected(item, ownerFilter, auth))
        .map((item) => item.kind === "me" ? "Me" : item.label);
    return selected.length > 0 ? selected.join(" + ") : "All sessions";
}

export function selectSessionOwnerFilterModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "sessionOwnerFilter") return null;
    const items = Array.isArray(modal.items) ? modal.items : [];
    const ownerFilter = state.sessions?.ownerFilter || { all: true };
    const auth = state.auth || {};
    const selectedIndex = Math.max(0, Math.min(Number(modal.selectedIndex) || 0, Math.max(0, items.length - 1)));
    const selectedItem = items[selectedIndex] || null;
    const rows = items.map((item, index) => {
        const checked = isOwnerFilterItemSelected(item, ownerFilter, auth);
        const labelColor = item.kind === "system"
            ? "yellow"
            : item.kind === "unowned"
                ? "gray"
                : item.kind === "all"
                    ? "cyan"
                    : "white";
        const rowRuns = [
            { text: checked ? "[x] " : "[ ] ", color: checked ? "cyan" : "gray", bold: checked },
            { text: item.label || item.id, color: labelColor, bold: checked },
        ];
        return index === selectedIndex
            ? applyActiveHighlightRuns(rowRuns, { preserveColors: true })
            : rowRuns;
    });
    const detailsLines = [
        [{
            text: "Active: ",
            color: "gray",
        }, {
            text: summarizeOwnerFilter(items, ownerFilter, auth),
            color: "white",
            bold: true,
        }],
        [{ text: "", color: "gray" }],
        [{
            text: selectedItem?.description || "Toggle which session owners appear in the session list.",
            color: "white",
        }],
        [{ text: "", color: "gray" }],
        [{
            text: "Space",
            color: "cyan",
            bold: true,
        }, {
            text: " toggle  ",
            color: "gray",
        }, {
            text: "Esc",
            color: "cyan",
            bold: true,
        }, {
            text: " close",
            color: "gray",
        }],
    ];

    return {
        title: modal.title || "Session Filter",
        rows: rows.length > 0 ? rows : [{ text: "No filter entries available.", color: "gray" }],
        selectedRowIndex: selectedIndex,
        detailsTitle: selectedItem?.label || "Session Filter",
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                48,
                rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? flattenRunsLength(row) : displayLength(row?.text || "")), 0) + 8,
                displayLength(summarizeOwnerFilter(items, ownerFilter, auth)) + 16,
            ),
            maxWidth,
        ),
    };
}

export function selectLogFilterModal(state, maxWidth = 96) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "logFilter") return null;
    return buildFilterModalPresentation(
        modal,
        state.logs?.filter || {},
        maxWidth,
        "Log Filters",
        "Choose how the log pane is filtered and rendered.",
    );
}

export function selectFilesFilterModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "filesFilter") return null;
    return buildFilterModalPresentation(
        modal,
        state.files?.filter || {},
        maxWidth,
        "Files Filter",
        "Choose whether the files browser shows the selected session tree or aggregates artifacts across all sessions.",
    );
}

export function selectArtifactPickerModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "artifactPicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const contentWidth = Math.max(28, maxWidth - 4);
    const artifactItems = items.filter((item) => item.kind === "artifact");
    const linkItems = items.filter((item) => item.kind === "url");
    const downloadedCount = artifactItems.reduce((count, item) => {
        const download = state.files?.bySessionId?.[item.sessionId]?.downloads?.[item.filename];
        return count + (download?.localPath ? 1 : 0);
    }, 0);
    const pendingCount = Math.max(0, artifactItems.length - downloadedCount);

    const rows = items.map((item, index) => {
        let runs;
        if (item.kind === "downloadAll") {
            runs = fitRuns([
                { text: "dl ", color: "cyan", bold: true },
                { text: "Download All", color: "white", bold: true },
                { text: ` [${pendingCount} pending]`, color: "gray" },
            ], contentWidth);
        } else if (item.kind === "url") {
            runs = fitRuns([
                { text: "go ", color: "cyan", bold: true },
                { text: item.text && item.text !== item.href ? item.text : item.href, color: "white", bold: true },
                ...(item.text && item.text !== item.href
                    ? [{ text: ` ${item.href}`, color: "gray" }]
                    : []),
            ], contentWidth);
        } else {
            const download = state.files?.bySessionId?.[item.sessionId]?.downloads?.[item.filename];
            runs = fitRuns([
                {
                    text: download?.localPath ? "ok " : "dl ",
                    color: download?.localPath ? "green" : "cyan",
                    bold: true,
                },
                { text: `${shortSessionId(item.sessionId)}/`, color: "gray" },
                { text: item.filename, color: "white" },
            ], contentWidth);
        }

        if (index !== selectedIndex) return runs;
        return buildActiveHighlightLine(runs.map((run) => run.text).join("").padEnd(contentWidth, " "));
    });

    const selectedItem = items[selectedIndex] || null;
    let detailsLines = [[{ text: "No linked item selected.", color: "gray" }]];
    if (selectedItem?.kind === "downloadAll") {
        detailsLines = [
            [{ text: `${artifactItems.length} artifacts available`, color: "white", bold: true }],
            ...(linkItems.length > 0 ? [[{ text: `${linkItems.length} links available`, color: "gray" }]] : []),
            [{ text: `${downloadedCount} already downloaded`, color: "gray" }],
            [{ text: `${pendingCount} pending download`, color: "gray" }],
            ...(modal.exportDirectory ? [[{ text: `Save location: ${modal.exportDirectory}`, color: "white" }]] : []),
            [{ text: "", color: "gray" }],
            [{ text: "Press Enter to download all pending artifacts.", color: "white" }],
            [{ text: "Press a or Esc to close the picker.", color: "gray" }],
        ];
    } else if (selectedItem?.kind === "url") {
        detailsLines = [
            [{ text: selectedItem.text || selectedItem.href, color: "white", bold: true }],
            [{ text: selectedItem.href, color: "gray" }],
            [{ text: "", color: "gray" }],
            [{ text: "Press Enter to open this link in the browser.", color: "white" }],
            [{ text: "Press a or Esc to close the picker.", color: "gray" }],
        ];
    } else if (selectedItem?.kind === "artifact") {
        const session = state.sessions?.byId?.[selectedItem.sessionId] || null;
        const download = state.files?.bySessionId?.[selectedItem.sessionId]?.downloads?.[selectedItem.filename] || null;
        detailsLines = [
            [{ text: selectedItem.filename, color: "white", bold: true }],
            [{ text: session ? buildSessionTitle(session, state.branding?.title) : shortSessionId(selectedItem.sessionId), color: "gray" }],
            ...(download?.localPath
                ? [[{ text: `Saved to: ${download.localPath}`, color: "white" }]]
                : modal.exportDirectory
                    ? [[{ text: `Save location: ${modal.exportDirectory}`, color: "white" }]]
                    : []),
            [{ text: "", color: "gray" }],
            [{
                text: download?.localPath
                    ? "Press Enter to download this artifact again."
                    : "Press Enter to download this artifact.",
                color: "white",
            }],
            [{ text: "Press a or Esc to close the picker.", color: "gray" }],
        ];
    }

    return {
        title: modal.title || "Linked Items",
        rows: rows.length > 0 ? rows : [{ text: "No linked items available.", color: "gray" }],
        selectedRowIndex: selectedIndex,
        detailsTitle: "Linked Item Details",
        detailsLines,
        confirmLabel: linkItems.length > 0 ? (artifactItems.length > 0 ? "Open / Download" : "Open") : "Download",
        idealWidth: Math.min(
            Math.max(
                54,
                rows.reduce((max, row) => {
                    if (Array.isArray(row)) return Math.max(max, flattenRunsLength(row));
                    return Math.max(max, String(row?.text || "").length);
                }, 0) + 4,
            ),
            maxWidth,
        ),
    };
}

// ── Stats Inspector Pane ────────────────────────────────────────────

function formatCompactNumber(n) {
    if (n == null || !Number.isFinite(n)) return "0";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
    if (n >= 1_000) return n.toLocaleString("en-US");
    return String(n);
}

function formatRelativeTime(ts) {
    if (!ts) return "—";
    const ms = Date.now() - ts;
    if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

// Coarse session-age buckets for the list. Seconds tick too fast and just
// distract, so the smallest bucket is "<1min"; then whole minutes to an hour,
// then hours+minutes, then days+hours, then weeks. No "ago" suffix — the age
// column context makes it clear.
function formatSessionAge(ts) {
    if (!ts) return "—";
    const ms = Date.now() - ts;
    if (ms < 60_000) return "<1min";
    const totalMin = Math.floor(ms / 60_000);
    if (totalMin < 60) return `${totalMin}min`;
    const totalHours = Math.floor(totalMin / 60);
    if (totalHours < 24) return `${totalHours}h${String(totalMin % 60).padStart(2, "0")}m`;
    const days = Math.floor(totalHours / 24);
    if (days < 14) return `${days}d${String(totalHours % 24).padStart(2, "0")}h`;
    return `${Math.floor(days / 7)}w`;
}

function formatLocalTimestamp(ts) {
    if (!ts) return "—";
    const date = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
    });
}

function normalizeStatsViewMode(mode) {
    return ["session", "fleet", "users"].includes(mode) ? mode : "session";
}

function buildStatsViewHeader(activeMode, width) {
    const mode = normalizeStatsViewMode(activeMode);
    const runs = [
        { text: "View ", color: "cyan", bold: true },
    ];
    for (const option of ["session", "fleet", "users"]) {
        runs.push({
            text: option === mode ? `[${option}]` : option,
            color: option === mode ? "magenta" : "gray",
            bold: option === mode,
        });
        runs.push({ text: " ", color: "gray" });
    }
    runs.push({ text: " [f cycle]", color: "gray" });
    return fitRuns(runs, width);
}

function buildSessionStatsLines(state, session, maxWidth) {
    if (!session) return [plainInspectorLine("No session selected.")];

    const entry = state.sessionStats?.bySessionId?.[session.sessionId] || null;
    if (!entry || (entry.loading && !entry.summary)) {
        return [plainInspectorLine("Loading session stats...")];
    }
    const summary = entry.summary;
    if (!summary) {
        return [plainInspectorLine("Session stats unavailable.")];
    }

    const lines = [];
    const w = Math.max(24, maxWidth);

    lines.push(buildStatsViewHeader("session", w));
    lines.push(plainInspectorLine(""));

    // Session identity
    lines.push(fitRuns([
        { text: "Session  ", color: "cyan", bold: true },
        { text: shortSessionId(session.sessionId), color: "white" },
    ], w));
    const ownerType = session.isSystem
        ? "system"
        : session.owner
            ? "user"
            : "unowned";
    const ownerName = session.isSystem
        ? "system"
        : session.owner
            ? ownerDisplayName(session.owner)
            : "(?) unowned";
    const ownerEmail = session.owner?.email || "—";
    lines.push(fitRuns([
        { text: "Owner    ", color: "cyan", bold: true },
        { text: ownerName, color: session.owner ? "white" : "gray" },
    ], w));
    lines.push(fitRuns([
        { text: "Email    ", color: "cyan", bold: true },
        { text: ownerEmail, color: session.owner?.email ? "white" : "gray" },
    ], w));
    lines.push(fitRuns([
        { text: "Type     ", color: "cyan", bold: true },
        { text: ownerType, color: ownerType === "user" ? "white" : "gray" },
    ], w));
    if (summary.agentId) {
        lines.push(fitRuns([
            { text: "Agent    ", color: "cyan", bold: true },
            { text: summary.agentId, color: "white" },
        ], w));
    }
    const summaryModelLabel = shortModelReasoningLabel(
        summary.model || session.model,
        summary.reasoningEffort || session.reasoningEffort,
    );
    if (summaryModelLabel) {
        lines.push(fitRuns([
            { text: "Model    ", color: "cyan", bold: true },
            { text: summaryModelLabel, color: "white" },
        ], w));
    }
    if (session.createdAt) {
        lines.push(fitRuns([
            { text: "Created  ", color: "cyan", bold: true },
            { text: formatLocalTimestamp(session.createdAt), color: "white" },
        ], w));
    }
    if (session.updatedAt) {
        lines.push(fitRuns([
            { text: "Updated  ", color: "cyan", bold: true },
            { text: formatLocalTimestamp(session.updatedAt), color: "white" },
        ], w));
    }
    lines.push(plainInspectorLine(""));

    const tokensByModel = Array.isArray(entry.tokensByModel) ? entry.tokensByModel : [];
    if (tokensByModel.length > 1) {
        lines.push(...buildMessageCardLines({
            title: "Models",
            body: tokensByModel
                .map((row) => `${shortBucketModelLabel(row.model)} · ${row.turnCount || 0} turns · ${formatCompactNumber(row.totalTokensInput)} in / ${formatCompactNumber(row.totalTokensOutput)} out`)
                .join("\n"),
            width: w,
            titleColor: "cyan",
            borderColor: "gray",
            fitToContent: true,
        }));
        lines.push(plainInspectorLine(""));
    }

    // Token usage card
    const tokTotal = (summary.tokensInput || 0) + (summary.tokensOutput || 0);
    const hitRatio = summary.cacheHitRatio;
    const hitRatioLabel = hitRatio == null
        ? "—"
        : `${(hitRatio * 100).toFixed(1)}%`;
    lines.push(...buildMessageCardLines({
        title: "Tokens",
        body: formatKeyValueTable([
            ["Input",       formatCompactNumber(summary.tokensInput)],
            ["Output",      formatCompactNumber(summary.tokensOutput)],
            ["Total",       formatCompactNumber(tokTotal)],
            ["Cache Read",  formatCompactNumber(summary.tokensCacheRead)],
            ["Cache Write", formatCompactNumber(summary.tokensCacheWrite)],
            ["Hit Ratio",   hitRatioLabel],
        ]),
        width: w,
        titleColor: "green",
        borderColor: "gray",
        fitToContent: true,
    }));
    lines.push(plainInspectorLine(""));

    // Persistence card
    lines.push(...buildMessageCardLines({
        title: "Persistence",
        body: formatKeyValueTable([
            ["Snapshot",        formatCompactBytes(summary.snapshotSizeBytes)],
            ["Uncompressed",    summary.rawSizeBytes ? formatCompactBytes(summary.rawSizeBytes) : null],
            ["Compression",     formatCompressionRatio(summary.rawSizeBytes, summary.snapshotSizeBytes)],
            ["Dehydrations",    String(summary.dehydrationCount)],
            ["Hydrations",      String(summary.hydrationCount)],
            ["Lossy Handoffs",  String(summary.lossyHandoffCount)],
            ["Last Dehydrated", summary.lastDehydratedAt ? formatLocalTimestamp(summary.lastDehydratedAt) : null],
            ["Last Hydrated",   summary.lastHydratedAt ? formatLocalTimestamp(summary.lastHydratedAt) : null],
        ]),
        width: w,
        titleColor: "yellow",
        borderColor: "gray",
        fitToContent: true,
    }));

    // Tree stats (if has children)
    const tree = entry.treeStats?.tree;
    if (tree && tree.sessionCount > 1) {
        const treeHit = tree.cacheHitRatio;
        const treeHitLabel = treeHit == null ? "—" : `${(treeHit * 100).toFixed(1)}%`;
        const treeTotal = (tree.totalTokensInput || 0) + (tree.totalTokensOutput || 0);
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Tree (${tree.sessionCount} sessions)`,
            body: formatKeyValueTable([
                ["Input",        formatCompactNumber(tree.totalTokensInput)],
                ["Output",       formatCompactNumber(tree.totalTokensOutput)],
                ["Total",        formatCompactNumber(treeTotal)],
                ["Cache Read",   formatCompactNumber(tree.totalTokensCacheRead)],
                ["Cache Write",  formatCompactNumber(tree.totalTokensCacheWrite)],
                ["Hit Ratio",    treeHitLabel],
                ["Snapshot",     formatCompactBytes(tree.totalSnapshotSizeBytes)],
                ["Uncompressed", tree.totalRawSizeBytes ? formatCompactBytes(tree.totalRawSizeBytes) : null],
                ["Compression",  formatCompressionRatio(tree.totalRawSizeBytes, tree.totalSnapshotSizeBytes)],
                ["Dehydrations", String(tree.totalDehydrationCount)],
                ["Hydrations",   String(tree.totalHydrationCount)],
            ]),
            width: w,
            titleColor: "magenta",
            borderColor: "gray",
            fitToContent: true,
        }));

        // Tree breakdown by model (mirrors fleet "Tokens By Model" card).
        const byModel = Array.isArray(entry.treeStats?.byModel) ? entry.treeStats.byModel : [];
        if (byModel.length > 1) {
            lines.push(plainInspectorLine(""));
            lines.push(...buildMessageCardLines({
                title: "Tree By Model",
                body: buildTreeByModelBody(byModel),
                width: w,
                titleColor: "cyan",
                borderColor: "gray",
                fitToContent: true,
            }));
        }
    }

    // Skills usage card (static + learned)
    const skills = Array.isArray(entry.skillUsage) ? entry.skillUsage : [];
    if (skills.length > 0) {
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Skills (${skills.length})`,
            body: buildSkillsBody(skills, w),
            width: w,
            titleColor: "cyan",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    // Tree skills card — only when there are descendants and the tree's
    // rolled-up skill usage diverges from the session's own. Same row format
    // as the per-session Skills card.
    const treeSkillUsage = entry.treeSkillUsage;
    const treeSkillRolled = Array.isArray(treeSkillUsage?.rolledUp) ? treeSkillUsage.rolledUp : [];
    const treeSessionCount = Array.isArray(treeSkillUsage?.perSession) ? treeSkillUsage.perSession.length : 0;
    if (treeSkillRolled.length > 0 && treeSessionCount > 1) {
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Tree Skills (${treeSkillRolled.length})`,
            body: buildSkillsBody(treeSkillRolled, w),
            width: w,
            titleColor: "cyan",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    // Facts card — per-session non-shared facts grouped by namespace.
    // When the session has descendants and tree facts differ from per-session
    // facts, append a "Tree" line so investigators can see lineage growth.
    const facts = entry.factsStats;
    const treeFacts = entry.treeFactsStats;
    if (facts && Array.isArray(facts.rows) && facts.rows.length > 0) {
        lines.push(plainInspectorLine(""));
        const body = buildFactsBody(facts.rows);
        const lineCount = body ? body.split("\n").length : 0;
        const titleSuffix = `${facts.totalCount} · ${formatCompactBytes(facts.totalBytes)}`;
        let composedBody = body;
        if (treeFacts && treeFacts.totalCount > facts.totalCount) {
            composedBody += `\n  Tree (${treeFacts.sessionIds.length} sessions): ${treeFacts.totalCount} · ${formatCompactBytes(treeFacts.totalBytes)}`;
        }
        if (lineCount > 0) {
            lines.push(...buildMessageCardLines({
                title: `Facts (${titleSuffix})`,
                body: composedBody,
                width: w,
                titleColor: "blue",
                borderColor: "gray",
                fitToContent: true,
            }));
        }
    }

    return lines;
}

/**
 * Render a flat list of `[label, value]` pairs as a single-column key/value
 * table where labels are left-aligned to the longest label and values are
 * right-aligned to the longest value. This is the canonical layout for stats
 * cards — multi-column rows with mixed-width labels never line up cleanly,
 * so all stats cards normalize to this single-column form.
 *
 * Pairs whose value is null/undefined are dropped so the card scales when
 * a row is unavailable (e.g. no `lastDehydratedAt` yet).
 */
function formatKeyValueTable(pairs, options = {}) {
    const gap = options.gap ?? 2;
    const rows = (pairs || []).filter((row) => Array.isArray(row) && row[1] != null && row[1] !== "");
    if (rows.length === 0) return "";
    const labelWidth = rows.reduce((max, [label]) => Math.max(max, String(label).length), 0);
    const valueWidth = rows.reduce((max, [, value]) => Math.max(max, String(value).length), 0);
    const filler = " ".repeat(gap);
    return rows
        .map(([label, value]) => `${String(label).padEnd(labelWidth)}${filler}${String(value).padStart(valueWidth)}`)
        .join("\n");
}

/**
 * Truncate a string to a maximum visible width, appending an
 * ellipsis if it had to be cut. Used by mobile-aware label
 * formatters that need to keep table rows on a single line.
 */
function ellipsize(value, maxWidth) {
    const text = String(value == null ? "" : value);
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) return text;
    const limit = Math.floor(maxWidth);
    if (text.length <= limit) return text;
    if (limit <= 1) return text.slice(0, limit);
    return `${text.slice(0, limit - 1)}…`;
}

/**
 * Render a list of rows (each an array of cell strings) as a left-aligned
 * column table. The width of each column is derived from the widest cell
 * in that column. The first column is left-aligned (the label); every
 * other column is right-aligned (the count/byte value).
 *
 * Cells whose value is null/undefined are rendered as an empty string.
 */
function formatColumnTable(rows, options = {}) {
    const gap = options.gap ?? 2;
    const cleaned = (rows || []).filter((row) => Array.isArray(row) && row.length > 0);
    if (cleaned.length === 0) return "";
    const colCount = cleaned.reduce((max, row) => Math.max(max, row.length), 0);
    const widths = new Array(colCount).fill(0);
    for (const row of cleaned) {
        for (let i = 0; i < colCount; i += 1) {
            const cell = row[i] == null ? "" : String(row[i]);
            if (cell.length > widths[i]) widths[i] = cell.length;
        }
    }
    const filler = " ".repeat(gap);
    return cleaned
        .map((row) => row
            .map((cell, i) => {
                const text = cell == null ? "" : String(cell);
                if (i === 0) return text.padEnd(widths[i]);
                return text.padStart(widths[i]);
            })
            .join(filler))
        .join("\n");
}

/** Render a list of SkillUsageRow into a compact body string. */
function buildSkillsBody(rows, maxWidth) {
    // Truncate to top 12 by invocations to keep the card short.
    const top = rows.slice().sort((a, b) => (b.invocations || 0) - (a.invocations || 0)).slice(0, 12);
    // Build the right-side column first so we know how much horizontal
    // space the label has left. Card chrome eats 4 chars (│ + space
    // each side); each gap between columns is 2 chars (matches
    // formatColumnTable's default).
    const rightCells = top.map((r) => `${r.invocations || 0} inv`);
    const rightWidth = rightCells.reduce((m, c) => Math.max(m, c.length), 0);
    const cardChrome = 4;
    const colGap = 2;
    const reserve = cardChrome + colGap + rightWidth;
    const labelMax = Number.isFinite(maxWidth) && maxWidth > 0
        ? Math.max(8, Math.floor(maxWidth) - reserve)
        : Infinity;
    const tableRows = top.map((r, i) => {
        const tag = r.kind === "learned" ? "L" : "S";
        const name = String(r.name || "(unknown)");
        const label = ellipsize(`${tag} ${name}`, labelMax);
        return [label, rightCells[i]];
    });
    const body = formatColumnTable(tableRows);
    if (rows.length > top.length) {
        return `${body}\n… ${rows.length - top.length} more`;
    }
    return body;
}

/** Render facts-stats rows (per session, tree, or shared) into a compact body. */
function buildFactsBody(rows) {
    const sorted = rows.slice().sort((a, b) => (b.factCount || 0) - (a.factCount || 0));
    const tableRows = sorted.map((r) => [
        String(r.namespace || "(other)"),
        String(r.factCount || 0),
        formatCompactBytes(r.totalValueBytes || 0),
    ]);
    return formatColumnTable(tableRows);
}

function buildFactsTombstoneBody(stats) {
    const oldest = stats.oldestUnreconciledAgeSeconds == null
        ? "-"
        : formatHumanDurationSeconds(Math.max(0, Number(stats.oldestUnreconciledAgeSeconds) || 0));
    return formatColumnTable([
        ["pending", String(Number(stats.pendingTotal) || 0)],
        ["unreconciled", String(Number(stats.unreconciled) || 0)],
        ["ttl-blocked", String(Number(stats.ttlBlocked) || 0)],
        ["oldest", oldest],
        ["reconciled", String(Number(stats.reconciledUnswept) || 0)],
    ]);
}

function retrievalOperationLabel(operation) {
    switch (operation) {
        case "facts_search": return "facts search";
        case "facts_similar": return "facts similar";
        case "search_skills": return "skill search";
        case "graph_search_nodes": return "graph nodes";
        case "graph_search_edges": return "graph edges";
        case "graph_neighbourhood": return "graph hood";
        default: return String(operation || "retrieval");
    }
}

function buildFleetRetrievalBody(rows, maxWidth) {
    const top = rows
        .slice()
        .sort((a, b) => (Number(b.calls) || 0) - (Number(a.calls) || 0))
        .slice(0, 12);
    const callCells = top.map((r) => `${Number(r.calls) || 0} calls`);
    const resultCells = top.map((r) => `${Number(r.totalResults) || 0} res`);
    const callW = callCells.reduce((m, c) => Math.max(m, c.length), 0);
    const resultW = resultCells.reduce((m, c) => Math.max(m, c.length), 0);
    const reserve = 4 + 2 + callW + 2 + resultW;
    const labelMax = Number.isFinite(maxWidth) && maxWidth > 0
        ? Math.max(10, Math.floor(maxWidth) - reserve)
        : Infinity;
    const tableRows = top.map((r, i) => {
        const namespace = r.namespace ? ` ${r.namespace}` : "";
        const label = ellipsize(`${retrievalOperationLabel(r.operation)}${namespace}`, labelMax);
        return [label, callCells[i], resultCells[i]];
    });
    const body = formatColumnTable(tableRows);
    if (rows.length > top.length) {
        return `${body}\n… ${rows.length - top.length} more`;
    }
    return body;
}

function buildFleetStatsLines(state, maxWidth) {
    const fleet = state.fleetStats;
    if (!fleet || (fleet.loading && !fleet.data)) {
        return [plainInspectorLine("Loading fleet stats...")];
    }
    const data = fleet.data;
    if (!data) {
        return [plainInspectorLine("Fleet stats unavailable.")];
    }

    const lines = [];
    const w = Math.max(24, maxWidth);

    lines.push(buildStatsViewHeader("fleet", w));
    lines.push(plainInspectorLine(""));

    // Header
    const sinceLabel = data.windowStart
        ? `Since: ${formatRelativeTime(data.windowStart).replace(" ago", "")}`
        : "All time";
    const earliestLabel = data.earliestSessionCreatedAt
        ? `Earliest: ${new Date(data.earliestSessionCreatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
        : "";
    lines.push(fitRuns([
        { text: sinceLabel, color: "cyan" },
        { text: earliestLabel ? `  ${earliestLabel}` : "", color: "gray" },
    ], w));
    lines.push(fitRuns([
        { text: `Sessions: ${data.totals.sessionCount}`, color: "white" },
        { text: `   Tokens: ${formatCompactNumber(data.totals.totalTokensInput)} in / ${formatCompactNumber(data.totals.totalTokensOutput)} out`, color: "white" },
    ], w));
    lines.push(plainInspectorLine(""));

    const byModel = new Map();
    for (const group of data.byAgent || []) {
        const modelLabel = group.model || "(default)";
        const current = byModel.get(modelLabel) || {
            totalTokensInput: 0,
            totalTokensOutput: 0,
            totalTokensCacheRead: 0,
            totalTokensCacheWrite: 0,
            totalSnapshotSizeBytes: 0,
            turnCount: 0,
        };
        current.totalTokensInput += Number(group.totalTokensInput) || 0;
        current.totalTokensOutput += Number(group.totalTokensOutput) || 0;
        current.totalTokensCacheRead += Number(group.totalTokensCacheRead) || 0;
        current.totalTokensCacheWrite += Number(group.totalTokensCacheWrite) || 0;
        current.totalSnapshotSizeBytes += Number(group.totalSnapshotSizeBytes) || 0;
        current.turnCount += Number(group.turnCount) || 0;
        byModel.set(modelLabel, current);
    }

    if (byModel.size > 0) {
        const groupLines = [];
        for (const [modelLabel, totals] of byModel.entries()) {
            const ratio = totals.totalTokensInput > 0
                ? (totals.totalTokensCacheRead / totals.totalTokensInput)
                : null;
            groupLines.push(modelLabel);
            groupLines.push(formatModelTotalsTable(totals, ratio));
            groupLines.push("");
        }
        lines.push(...buildMessageCardLines({
            title: "Tokens By Model",
            body: groupLines.join("\n").trimEnd(),
            width: w,
            titleColor: "cyan",
            borderColor: "gray",
            fitToContent: true,
        }));
        lines.push(plainInspectorLine(""));
    }

    // Fleet totals card
    const fleetHitRatio = data.totals.cacheHitRatio;
    const fleetHitLabel = fleetHitRatio == null
        ? "—"
        : `${(fleetHitRatio * 100).toFixed(1)}%`;
    lines.push(...buildMessageCardLines({
        title: "Fleet Totals",
        body: formatKeyValueTable([
            ["Sessions",     String(data.totals.sessionCount)],
            ["Tokens In",    formatCompactNumber(data.totals.totalTokensInput)],
            ["Tokens Out",   formatCompactNumber(data.totals.totalTokensOutput)],
            ["Total Tokens", formatCompactNumber(data.totals.totalTokensInput + data.totals.totalTokensOutput)],
            ["Cache Read",   formatCompactNumber(data.totals.totalTokensCacheRead)],
            ["Cache Write",  formatCompactNumber(data.totals.totalTokensCacheWrite)],
            ["Hit Ratio",    fleetHitLabel],
            ["Snapshots",    formatCompactBytes(data.totals.totalSnapshotSizeBytes)],
        ]),
        width: w,
        titleColor: "green",
        borderColor: "gray",
        fitToContent: true,
    }));

    // Fleet skills usage (top static + learned across the window).
    // Filter out facts-manager skills/% rows: these are facts namespace
    // accounting, not real skill invocations.
    const fleetSkillRows = (Array.isArray(fleet.skillUsage?.rows) ? fleet.skillUsage.rows : [])
        .filter((r) => !(r && r.agentId === "facts-manager" && String(r.name || "").startsWith("skills/")));
    if (fleetSkillRows.length > 0) {
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Fleet Skills (${fleetSkillRows.length})`,
            body: buildFleetSkillsBody(fleetSkillRows, maxWidth),
            width: w,
            titleColor: "cyan",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    const retrievalRows = Array.isArray(fleet.retrievalUsage?.rows) ? fleet.retrievalUsage.rows : [];
    if (retrievalRows.length > 0) {
        const totalCalls = retrievalRows.reduce((sum, row) => sum + (Number(row.calls) || 0), 0);
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Fleet Retrieval (${formatCompactNumber(totalCalls)})`,
            body: buildFleetRetrievalBody(retrievalRows, maxWidth),
            width: w,
            titleColor: "magenta",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    // Shared facts card (Facts Manager output, fleet-wide)
    const sharedFacts = fleet.sharedFactsStats;
    if (sharedFacts && Array.isArray(sharedFacts.rows) && sharedFacts.rows.length > 0) {
        lines.push(plainInspectorLine(""));
        const titleSuffix = `${sharedFacts.totalCount} · ${formatCompactBytes(sharedFacts.totalBytes)}`;
        lines.push(...buildMessageCardLines({
            title: `Shared Facts (${titleSuffix})`,
            body: buildFactsBody(sharedFacts.rows),
            width: w,
            titleColor: "blue",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    const tombstones = fleet.factsTombstoneStats;
    if (tombstones && Number(tombstones.pendingTotal) > 0) {
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `Fact Tombstones (${Number(tombstones.pendingTotal) || 0})`,
            body: buildFactsTombstoneBody(tombstones),
            width: w,
            titleColor: "yellow",
            borderColor: "gray",
            fitToContent: true,
        }));
    }

    return lines;
}

/** Render fleet skill rows: groups by skill kind/name across agents. */
function buildFleetSkillsBody(rows, maxWidth) {
    // Sort: kind S before L, then named agents before unscoped (./), then
    // alphabetical by agent then by name.
    const sorted = rows.slice().sort((a, b) => {
        const kindRank = (k) => (k === "learned" ? 1 : 0); // S=0, L=1
        const dk = kindRank(a.kind) - kindRank(b.kind);
        if (dk !== 0) return dk;
        const aNamed = a.agentId ? 0 : 1;
        const bNamed = b.agentId ? 0 : 1;
        if (aNamed !== bNamed) return aNamed - bNamed;
        const da = String(a.agentId || "").localeCompare(String(b.agentId || ""));
        if (da !== 0) return da;
        return String(a.name || "").localeCompare(String(b.name || ""));
    });
    const top = sorted.slice(0, 15);
    // Compute the right-side column widths from real data so the label
    // reserve is exact, not a guess. Card chrome is 4 chars; each gap
    // between formatColumnTable columns is 2 chars (default).
    const invCells  = top.map((r) => `${r.invocations  || 0} inv`);
    const sessCells = top.map((r) => `${r.sessionCount || 0} sess`);
    const invW  = invCells.reduce((m, c) => Math.max(m, c.length), 0);
    const sessW = sessCells.reduce((m, c) => Math.max(m, c.length), 0);
    const cardChrome = 4;
    const colGap = 2;
    const reserve = cardChrome + colGap + invW + colGap + sessW;
    const labelMax = Number.isFinite(maxWidth) && maxWidth > 0
        ? Math.max(10, Math.floor(maxWidth) - reserve)
        : Infinity;
    const tableRows = top.map((r, i) => {
        const tag = r.kind === "learned" ? "L" : "S";
        const agent = r.agentId || ".";
        const name = String(r.name || "(unknown)");
        const label = ellipsize(`${tag} ${agent}/${name}`, labelMax);
        return [label, invCells[i], sessCells[i]];
    });
    const body = formatColumnTable(tableRows);
    if (rows.length > top.length) {
        return `${body}\n… ${rows.length - top.length} more`;
    }
    return body;
}

/** Render the per-tree by-model breakdown (mirrors fleet "Tokens By Model"). */
function buildTreeByModelBody(rows) {
    const sorted = rows.slice().sort((a, b) => (b.totalTokensInput || 0) - (a.totalTokensInput || 0));
    const out = [];
    for (const r of sorted) {
        const ratio = r.cacheHitRatio;
        out.push(`${String(r.model || "(unknown)")}  · ${r.sessionCount || 0} sess · ${r.turnCount || 0} turns`);
        out.push(formatModelTotalsTable(r, ratio));
        out.push("");
    }
    return out.join("\n").trimEnd();
}

/**
 * Single-model totals as a compact key/value table, indented two spaces so
 * it sits visually under the model header line. Used by both the fleet
 * "Tokens By Model" card and the per-session "Tree By Model" card.
 */
function formatModelTotalsTable(totals, cacheHitRatio) {
    const ratioLabel = cacheHitRatio == null ? "—" : `${(cacheHitRatio * 100).toFixed(1)}%`;
    const total = (Number(totals.totalTokensInput) || 0) + (Number(totals.totalTokensOutput) || 0);
    const pairs = [
        ["Input",       formatCompactNumber(totals.totalTokensInput || 0)],
        ["Output",      formatCompactNumber(totals.totalTokensOutput || 0)],
        ["Total",       formatCompactNumber(total)],
        ["Turns",       formatCompactNumber(totals.turnCount || 0)],
        ["Cache Read",  formatCompactNumber(totals.totalTokensCacheRead || 0)],
        ["Cache Write", formatCompactNumber(totals.totalTokensCacheWrite || 0)],
        ["Hit Ratio",   ratioLabel],
        ["Snapshot",    formatCompactBytes(totals.totalSnapshotSizeBytes || 0)],
    ];
    if (Number.isFinite(Number(totals.totalOrchestrationHistorySizeBytes))) {
        pairs.push(["Orch", formatCompactBytes(totals.totalOrchestrationHistorySizeBytes || 0)]);
    }
    const body = formatKeyValueTable(pairs);
    return body.split("\n").map((line) => `  ${line}`).join("\n");
}

function userStatsDisplayName(user) {
    if (user?.ownerKind === "system") return "System";
    if (user?.ownerKind === "unowned") return "Unowned";
    return ownerDisplayName(user?.owner, "Unknown User");
}

function userStatsEmail(user) {
    if (user?.ownerKind !== "user") return "";
    const email = String(user?.owner?.email || "").trim();
    const name = userStatsDisplayName(user);
    return email && email !== name ? email : "";
}

function buildUserModelsBody(user, maxWidth) {
    const rows = Array.isArray(user?.byModel) ? user.byModel : [];
    if (rows.length === 0) return "";
    const top = rows
        .slice()
        .sort((a, b) => (b.totalTokensInput || 0) - (a.totalTokensInput || 0))
        .slice(0, 6);
    const lines = [];
    for (const row of top) {
        const model = ellipsize(String(row.model || "(default)"), Math.max(12, maxWidth - 10));
        lines.push(`${model} · ${row.sessionCount || 0} sess · ${row.turnCount || 0} turns`);
        lines.push(formatModelTotalsTable(row, row.cacheHitRatio));
        lines.push("");
    }
    if (rows.length > top.length) {
        lines.push(`… ${rows.length - top.length} more models`);
    }
    return lines.join("\n").trimEnd();
}

function buildUserStatsLines(state, maxWidth) {
    const fleet = state.fleetStats;
    if (!fleet || (fleet.loading && !fleet.userStats)) {
        return [plainInspectorLine("Loading user stats...")];
    }
    const data = fleet.userStats;
    if (!data) {
        return [plainInspectorLine("User stats unavailable.")];
    }

    const lines = [];
    const w = Math.max(24, maxWidth);
    lines.push(buildStatsViewHeader("users", w));
    lines.push(plainInspectorLine(""));

    const sinceLabel = data.windowStart
        ? `Since: ${formatRelativeTime(data.windowStart).replace(" ago", "")}`
        : "All time";
    const earliestLabel = data.earliestSessionCreatedAt
        ? `Earliest: ${new Date(data.earliestSessionCreatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
        : "";
    lines.push(fitRuns([
        { text: sinceLabel, color: "cyan" },
        { text: earliestLabel ? `  ${earliestLabel}` : "", color: "gray" },
    ], w));
    lines.push(fitRuns([
        { text: `Users: ${Array.isArray(data.users) ? data.users.length : 0}`, color: "white" },
        { text: `   Sessions: ${data.totals.sessionCount || 0}`, color: "white" },
    ], w));
    lines.push(plainInspectorLine(""));

    const hitRatio = data.totals.cacheHitRatio;
    const hitRatioLabel = hitRatio == null ? "—" : `${(hitRatio * 100).toFixed(1)}%`;
    lines.push(...buildMessageCardLines({
        title: "User Totals",
        body: formatKeyValueTable([
            ["Sessions",     String(data.totals.sessionCount || 0)],
            ["Tokens In",    formatCompactNumber(data.totals.totalTokensInput || 0)],
            ["Tokens Out",   formatCompactNumber(data.totals.totalTokensOutput || 0)],
            ["Total Tokens", formatCompactNumber((data.totals.totalTokensInput || 0) + (data.totals.totalTokensOutput || 0))],
            ["Cache Read",   formatCompactNumber(data.totals.totalTokensCacheRead || 0)],
            ["Cache Write",  formatCompactNumber(data.totals.totalTokensCacheWrite || 0)],
            ["Hit Ratio",    hitRatioLabel],
            ["Snapshots",    formatCompactBytes(data.totals.totalSnapshotSizeBytes || 0)],
            ["Orch Size",    formatCompactBytes(data.totals.totalOrchestrationHistorySizeBytes || 0)],
        ]),
        width: w,
        titleColor: "green",
        borderColor: "gray",
        fitToContent: true,
    }));

    const users = Array.isArray(data.users) ? data.users : [];
    const topUsers = users
        .slice()
        .sort((a, b) =>
            (b.totalTokensInput || 0) - (a.totalTokensInput || 0)
            || (b.totalSnapshotSizeBytes || 0) - (a.totalSnapshotSizeBytes || 0),
        )
        .slice(0, 8);
    for (const user of topUsers) {
        const email = userStatsEmail(user);
        const ratio = user.cacheHitRatio;
        const ratioLabel = ratio == null ? "—" : `${(ratio * 100).toFixed(1)}%`;
        const title = email
            ? `${userStatsDisplayName(user)} <${email}>`
            : userStatsDisplayName(user);
        const totalsBody = formatKeyValueTable([
            ["Sessions",     String(user.sessionCount || 0)],
            ["Tokens In",    formatCompactNumber(user.totalTokensInput || 0)],
            ["Tokens Out",   formatCompactNumber(user.totalTokensOutput || 0)],
            ["Total Tokens", formatCompactNumber((user.totalTokensInput || 0) + (user.totalTokensOutput || 0))],
            ["Cache Read",   formatCompactNumber(user.totalTokensCacheRead || 0)],
            ["Cache Write",  formatCompactNumber(user.totalTokensCacheWrite || 0)],
            ["Hit Ratio",    ratioLabel],
            ["Snapshots",    formatCompactBytes(user.totalSnapshotSizeBytes || 0)],
            ["Orch Size",    formatCompactBytes(user.totalOrchestrationHistorySizeBytes || 0)],
        ]);
        const modelsBody = buildUserModelsBody(user, w);
        lines.push(plainInspectorLine(""));
        lines.push(...buildMessageCardLines({
            title: `${title} (${user.sessionCount || 0})`,
            body: modelsBody ? `${totalsBody}\n\n${modelsBody}` : totalsBody,
            width: w,
            titleColor: user.ownerKind === "user" ? "cyan" : "yellow",
            borderColor: "gray",
            fitToContent: true,
        }));
    }
    if (users.length > topUsers.length) {
        lines.push(plainInspectorLine(""));
        lines.push(plainInspectorLine(`… ${users.length - topUsers.length} more users`));
    }

    return lines;
}

export function selectInspector(state, options = {}) {
    const session = selectActiveSession(state);
    const activeTab = state.ui.inspectorTab;
    const maxWidth = Math.max(18, Number(options?.width) || 36);
    const allowWideColumns = Boolean(options?.allowWideColumns);
    const compactSecondaryMeta = shouldCompactPaneTitleMetadata(maxWidth);

    if (session?.isGroup) {
        return {
            title: buildPaneTitleRuns("Inspector", "magenta"),
            activeTab,
            tabs: INSPECTOR_TABS,
            disabled: true,
            stickyLines: [],
            lines: [plainInspectorLine(SELECT_SESSION_DETAILS_MESSAGE, "gray")],
        };
    }

    const shortId = session ? shortSessionId(session.sessionId) : "";
    const recentWindow = activeTab === "sequence" || activeTab === "nodes"
        ? getRecentActivityWindow(state)
        : null;
    const title = activeTab === "nodes"
        ? [
            ...buildPaneTitleRuns("Node Map", "magenta"),
            ...(compactSecondaryMeta ? [] : [{ text: ` [${recentWindow.label}]`, color: "gray" }]),
        ]
        : !session
            ? (activeTab === "stats"
                ? `Stats: ${normalizeStatsViewMode(state.ui?.statsViewMode).replace(/^./u, (char) => char.toUpperCase())}`
                : "No session selected")
            : activeTab === "sequence"
            ? [
                ...buildPaneTitleRuns(compactSecondaryMeta ? "Sequence" : `Sequence: ${shortId}`, "magenta"),
                ...(compactSecondaryMeta ? [] : [{ text: ` [${recentWindow.label}]`, color: "gray" }]),
            ]
            : activeTab === "logs"
                ? [
                    ...buildPaneTitleRuns(compactSecondaryMeta ? "Logs" : `Logs: ${shortId}`, "magenta"),
                ]
                : activeTab === "history"
                    ? [
                        ...buildPaneTitleRuns(compactSecondaryMeta ? "History" : `History: ${shortId}`, "magenta"),
                    ]
                    : activeTab === "stats"
                        ? [
                            ...buildPaneTitleRuns(compactSecondaryMeta ? "Stats" : `Stats: ${shortId}`, "magenta"),
                            { text: ` [${normalizeStatsViewMode(state.ui?.statsViewMode)}]`, color: "gray" },
                        ]
                        : [
                            ...buildPaneTitleRuns(compactSecondaryMeta ? "Files" : `Files: ${shortId}`, "magenta"),
                        ];

    let lines;
    let stickyLines = [];
    switch (activeTab) {
        case "sequence": {
            const sequenceView = session
                ? buildSequenceViewForSession(state, session, maxWidth, { allowWideColumns, sequenceExpansion: options?.sequenceExpansion || null })
                : { stickyLines: [], lines: ["No session selected."] };
            stickyLines = sequenceView.stickyLines || [];
            lines = sequenceView.lines;
            break;
        }
        case "logs":
            lines = session
                ? selectLogPane(state, session)
                : ["No session selected."];
            break;
        case "nodes":
            lines = buildNodeMapLines(state, maxWidth, { allowWideColumns });
            break;
        case "files":
            lines = session
                ? ["Files view is rendered in the shared host layout."]
                : ["No session selected."];
            break;
        case "history":
            lines = session
                ? selectExecutionHistoryPane(state, session)
                : ["No session selected."];
            break;
        case "stats":
            lines = normalizeStatsViewMode(state.ui?.statsViewMode) === "users"
                ? buildUserStatsLines(state, maxWidth)
                : normalizeStatsViewMode(state.ui?.statsViewMode) === "fleet"
                ? buildFleetStatsLines(state, maxWidth)
                : session
                    ? buildSessionStatsLines(state, session, maxWidth)
                    : [
                        buildStatsViewHeader("session", Math.max(24, maxWidth)),
                        plainInspectorLine(""),
                        plainInspectorLine("No session selected. Press f to cycle to fleet or users view."),
                    ];
            break;
        default:
            lines = ["Inspector view is scaffolded in the new architecture."];
            break;
    }

    return {
        title,
        activeTab,
        tabs: INSPECTOR_TABS,
        stickyLines,
        lines,
    };
}

// ── Execution History Pane ──────────────────────────────────────────

const HISTORY_EVENT_KIND_COLORS = {
    OrchestratorStarted: "green",
    OrchestratorCompleted: "green",
    ExecutionStarted: "cyan",
    ExecutionCompleted: "cyan",
    TaskScheduled: "yellow",
    TaskCompleted: "yellow",
    TaskFailed: "red",
    SubOrchestrationCreated: "magenta",
    SubOrchestrationCompleted: "magenta",
    SubOrchestrationFailed: "red",
    TimerCreated: "blue",
    TimerFired: "blue",
    EventRaised: "white",
    EventSent: "white",
    CustomStatusUpdated: "gray",
};

const SELECT_SESSION_DETAILS_MESSAGE = "Select a session to see details.";

function formatHistoryEventPretty(event) {
    const ts = event.timestampMs
        ? new Date(event.timestampMs).toISOString().slice(11, 23)
        : "???";
    const color = HISTORY_EVENT_KIND_COLORS[event.kind] || "gray";
    const lines = [];
    const header = [
        { text: `#${event.eventId}`, color: "white", bold: true },
        { text: `  ${ts}`, color: "gray" },
        { text: `  ${event.kind}`, color, bold: event.kind.includes("Failed") },
    ];
    if (event.sourceEventId != null) {
        header.push({ text: `  ←#${event.sourceEventId}`, color: "cyan" });
    }
    lines.push(header);
    if (event.data) {
        try {
            const parsed = JSON.parse(event.data);
            if (typeof parsed === "object" && parsed !== null) {
                for (const [k, v] of Object.entries(parsed)) {
                    const s = typeof v === "string" ? v : JSON.stringify(v);
                    const display = s.length > 100 ? s.slice(0, 97) + "..." : s;
                    lines.push([
                        { text: `    ${k}: `, color: "yellow" },
                        { text: display, color: "white" },
                    ]);
                }
            } else {
                lines.push({ text: `    ${String(parsed).slice(0, 120)}`, color: "white" });
            }
        } catch {
            const display = event.data.length > 120 ? event.data.slice(0, 117) + "..." : event.data;
            lines.push({ text: `    ${display}`, color: "white" });
        }
    }
    return lines;
}

function formatHistoryEventRaw(event) {
    const clone = { ...event };
    if (clone.data) {
        try { clone.data = JSON.parse(clone.data); } catch { /* keep raw */ }
    }
    return JSON.stringify(clone, null, 2);
}

function selectExecutionHistoryPane(state, session) {
    const entry = state.executionHistory?.bySessionId?.[session.sessionId];
    if (!entry) return ["No execution history loaded. Press r to refresh."];
    if (entry.loading) return ["Loading execution history..."];
    if (entry.error) return [`Error: ${entry.error}`];
    const events = entry.events;
    if (!Array.isArray(events) || events.length === 0) return ["No history events found."];

    const format = state.executionHistory?.format || "pretty";
    const lines = [];
    lines.push({
        text: `${events.length} event(s) · format: ${format}`,
        color: "gray",
    });
    lines.push("");

    if (format === "raw") {
        for (let i = 0; i < events.length; i++) {
            const rawLines = formatHistoryEventRaw(events[i]).split("\n");
            for (const line of rawLines) {
                lines.push({ text: line, color: "gray" });
            }
            if (i < events.length - 1) {
                lines.push({ text: "────────────────────────────────", color: "gray" });
            }
        }
    } else {
        for (let i = 0; i < events.length; i++) {
            const eventLines = formatHistoryEventPretty(events[i]);
            for (const line of eventLines) {
                lines.push(line);
            }
            if (i < events.length - 1) {
                lines.push({ text: "────────────────────────────────", color: "gray" });
            }
        }
    }
    return lines;
}

export function selectHistoryFormatModal(state, maxWidth = 88) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "historyFormat") return null;
    return buildFilterModalPresentation(
        modal,
        { format: state.executionHistory?.format || "pretty" },
        maxWidth,
        "Execution History Format",
        "Choose the display format for duroxide execution history events.",
    );
}

function buildThemeSwatchRuns(entries = []) {
    const runs = [];
    for (const entry of entries) {
        if (runs.length > 0) runs.push({ text: "  ", color: "gray" });
        runs.push({ text: `${entry.label} `, color: "gray" });
        runs.push({
            text: "██",
            color: entry.color,
            backgroundColor: entry.color,
        });
    }
    return runs;
}

const KEYBINDING_HELP = [
    { section: "Global", bindings: [
        ["Tab / Shift-Tab", "focus next / previous pane"],
        ["h l   ← →", "focus left / right pane"],
        ["p", "focus the prompt"],
        ["[  ]", "shrink / grow the focused pane"],
        ["{  }", "grow left / right column"],
        ["v", "fullscreen the focused pane"],
        ["n / r", "new session / refresh"],
        ["a", "linked items — artifacts to download, links to open"],
        ["m", "cycle inspector tab"],
        ["c / d / D", "cancel / done / delete session"],
        ["ctrl-x  (ctrl-esc)", "stop the current turn", { dim: true }],
        ["T / N / M / A", "theme / new+model / switch model / admin"],
        ["?", "toggle this help"],
        ["q", "quit (double-tap)"],
        ["Esc", "back / focus sessions"],
    ] },
    { section: "Sessions pane", bindings: [
        ["j k   ↑ ↓", "move selection"],
        ["ctrl-u / ctrl-d", "page up / down"],
        ["ctrl-g", "move to group"],
        ["+ / -", "expand / collapse subtree"],
        ["t", "rename"],
        ["P", "pin / unpin"],
        ["V / space", "select mode / toggle selection"],
        ["f", "filter"],
    ] },
    { section: "Chat / transcript", bindings: [
        ["s", "toggle transcript / summary"],
        ["j k   ↑ ↓", "scroll"],
        ["ctrl-u / ctrl-d", "page"],
        ["e", "expand older history"],
        ["g / G", "top / bottom"],
    ] },
    { section: "Inspector pane", bindings: [
        ["← →   m", "previous / next / cycle tab"],
        ["j k", "scroll"],
        ["enter", "expand / collapse a turn (Sequence tab)"],
        ["logs", "t tail · f filter"],
        ["stats", "f cycle session/fleet/users"],
        ["files", "a download · x delete · u upload · o open · f filter · v full"],
        ["history", "r refresh · a export · f format"],
    ] },
    { section: "Activity pane", bindings: [
        ["j k   ↑ ↓", "scroll"],
        ["g / G", "top / bottom"],
    ] },
    { section: "Prompt", bindings: [
        ["enter", "send"],
        ["alt/ctrl-j", "newline"],
        ["ctrl-a", "attach artifact"],
        ["@ / @@", "artifact / session reference"],
    ] },
    { section: "Overlays", bindings: [
        ["Esc / q", "close"],
        ["enter", "confirm / apply"],
        ["j k   ↑ ↓", "navigate"],
        ["Tab", "switch modal pane"],
    ] },
];

export function buildHelpModalRows() {
    const rows = [];
    const keysWidth = 18;
    for (const group of KEYBINDING_HELP) {
        if (rows.length > 0) rows.push([{ text: "", color: "gray" }]);
        rows.push([{ text: group.section, color: "cyan", bold: true }]);
        for (const [keys, desc, opts] of group.bindings) {
            const dim = Boolean(opts?.dim);
            rows.push([
                { text: "  " + String(keys).padEnd(keysWidth), color: dim ? "gray" : "yellow" },
                { text: String(desc), color: dim ? "gray" : "white" },
            ]);
        }
    }
    return rows;
}

// TUI-only help overlay (the portal relies on tooltips). Reuses the single
// modal slot; opened with `?` and dismissed with `?`/Esc.
export function selectHelpModal(state, maxWidth = 88) {
    const modal = state.ui?.modal;
    if (!modal || modal.type !== "help") return null;
    const rows = buildHelpModalRows();
    const selectedRowIndex = Math.max(0, Math.min(Number(modal.selectedIndex) || 0, rows.length - 1));
    return {
        title: "Keybindings — ? or Esc to close",
        idealWidth: Math.max(64, Math.min(maxWidth, 88)),
        rows,
        selectedRowIndex,
    };
}

export function selectThemePickerModal(state, maxWidth = 80) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "themePicker") return null;

    const items = Array.isArray(modal.items) ? modal.items : [];
    const selectedIndex = Math.max(0, Number(modal.selectedIndex) || 0);
    const selectedItem = items[selectedIndex] || null;
    const originalThemeId = modal.currentThemeId || state.ui.themeId || null;
    const originalTheme = items.find((item) => item.id === originalThemeId) || null;
    const previewingTheme = selectedItem && selectedItem.id !== originalThemeId;
    const contentWidth = Math.max(24, maxWidth - 4);
    const rows = items.map((item, index) => {
        const suffix = item.id === originalThemeId ? " [current]" : "";
        const text = `${item.label}${suffix}`.slice(0, contentWidth);
        if (index === selectedIndex) {
            return buildActiveHighlightLine(text.padEnd(contentWidth, " "));
        }
        return [{
            text,
            color: item.id === originalThemeId ? "cyan" : "white",
            bold: item.id === originalThemeId,
        }];
    });

    const detailsLines = selectedItem
        ? [
            [{ text: `theme: ${selectedItem.description || "Shared theme for the portal and native TUI."}`, color: "white" }],
            { text: "", color: "gray" },
            [{
                text: previewingTheme
                    ? `Previewing now. Cancel reverts to ${originalTheme?.label || "the previous theme"}.`
                    : "Currently active in this TUI session.",
                color: previewingTheme ? "yellow" : "green",
            }],
            buildThemeSwatchRuns([
                { label: "bg", color: selectedItem.tui?.background || selectedItem.terminal?.background || "#000000" },
                { label: "surface", color: selectedItem.tui?.surface || selectedItem.terminal?.background || "#000000" },
                { label: "fg", color: selectedItem.tui?.white || selectedItem.terminal?.foreground || "#ffffff" },
            ]),
            buildThemeSwatchRuns([
                { label: "blue", color: selectedItem.tui?.blue || selectedItem.terminal?.blue || "#5555ff" },
                { label: "green", color: selectedItem.tui?.green || selectedItem.terminal?.green || "#55ff55" },
                { label: "magenta", color: selectedItem.tui?.magenta || selectedItem.terminal?.magenta || "#ff55ff" },
                { label: "yellow", color: selectedItem.tui?.yellow || selectedItem.terminal?.yellow || "#ffff55" },
            ]),
            { text: "", color: "gray" },
            [{ text: "Selecting previews immediately. Apply Theme keeps it; Cancel restores the previous theme.", color: "gray" }],
        ]
        : [{ text: "No themes available.", color: "gray" }];

    return {
        title: modal.title || "Theme Picker",
        idealWidth: Math.max(60, Math.min(maxWidth, 80)),
        rows,
        selectedRowIndex: selectedIndex,
        detailsTitle: "Theme Details",
        detailsLines,
    };
}

export function selectConfirmModal(state) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "confirm") return null;
    return {
        title: modal.title || "Confirm",
        message: modal.message || "Are you sure?",
        confirmLabel: modal.confirmLabel || "Confirm",
    };
}
