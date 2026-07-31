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
    formatTimestampCompact,
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
// Speaker label for a message from another person in a shared session.
const OTHER_PERSON_CHAT_LABEL_COLOR = "otherUserChatLabel";

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

// The owner key of the first-class System user. Sessions a system agent spawns
// on a user's behalf inherit this owner (they are NOT is_system, so they stay
// deletable) — but they belong to the same "System" bucket as the real system
// agents, so the single System filter entry covers both. Computed via the same
// join helper so it stays byte-identical to real owner keys.
const SYSTEM_OWNER_KEY = ownerKeyForOwner({ provider: "system", subject: "system" });

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
    // A narrowed filter counts as an explicit multi-user context ONLY when it
    // names specific owners. The DEFAULT signed-in filter already sets
    // `all: false` AND `includeShared: true` (see
    // defaultOwnerFilterForPrincipal), so testing either of those tagged every
    // row in a single-user deployment with a pointless "you are you" chip.
    // Everything else falls through to counting DISTINCT owners below, which
    // is what the chip actually communicates.
    const ownerFilter = state.sessions?.ownerFilter;
    if (Array.isArray(ownerFilter?.ownerKeys) && ownerFilter.ownerKeys.length > 0) return true;
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

// Titles are plain text everywhere they are rendered (terminal runs, DOM
// text nodes) — never interpreted as HTML. A title that arrived already
// HTML-escaped therefore shows its entities literally ("PostgreSQL &amp;
// MySQL"). Decoding the handful of entities an escaper emits repairs those
// rows on read; the write path also normalizes now, so this covers history.
const HTML_ENTITY_REPLACEMENTS = [
    [/&lt;/g, "<"],
    [/&gt;/g, ">"],
    [/&quot;/g, '"'],
    [/&#0?39;/g, "'"],
    [/&apos;/g, "'"],
    [/&nbsp;/g, " "],
    // Ampersand LAST: decoding it first would let "&amp;lt;" collapse to "<".
    [/&amp;/g, "&"],
];

export function decodeHtmlEntitiesForDisplay(value) {
    let text = String(value ?? "");
    if (!text.includes("&")) return text;
    for (const [pattern, replacement] of HTML_ENTITY_REPLACEMENTS) {
        text = text.replace(pattern, replacement);
    }
    return text;
}

function buildSessionDisplayTitle(session) {
    // Decode at the single exit so the agent-prefixed and typed-title paths
    // are covered too, not just the bare title.
    return decodeHtmlEntitiesForDisplay(buildRawSessionDisplayTitle(session));
}

function buildRawSessionDisplayTitle(session) {
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
    // Sessions OWNED BY the System user (children a system agent spawned) share
    // the "System" bucket with the real is_system agents — one entry, one
    // meaning. Gate them on includeSystem, never on Me / owner keys.
    if (ownerKey === SYSTEM_OWNER_KEY) return ownerFilter.includeSystem === true;
    const currentUserKey = ownerKeyForOwner(auth?.principal);
    if (ownerFilter.includeMe && currentUserKey && ownerKey === currentUserKey) return true;
    // "Shared with me": any non-system session owned by someone else. The
    // catalog is viewer-scoped server-side, so a foreign owner implies the
    // session was shared with (or is otherwise readable by) the viewer.
    if (ownerFilter.includeShared === true && ownerKey !== currentUserKey) return true;
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

export function formatCronTimestampForClient(value) {
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
    // Live regeneration chip: the orchestration publishes regenStage in
    // customStatus while the pipeline runs (archiving → distilling →
    // flipping) and getSession spreads it onto the session view. Magenta to
    // match the epoch divider; disappears when the flip lands.
    if (typeof session?.regenStage === "string" && session.regenStage) {
        runs.push({ text: `↻ regen:${session.regenStage}`, color: "magenta" });
    }
    const statusLabel = getSessionRowStatusLabel(session);
    if (statusLabel) {
        if (runs.length > 0) runs.push({ text: " · ", color: "gray" });
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

    // Multi-selection reads as a selection BAR on the chosen rows (plus the
    // host's own row styling) — not a checkbox column that shifts every row
    // the moment selection mode turns on.
    if (isSelected) {
        prefixRuns.push({ text: "▌", color: "cyan", bold: true });
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
    } else if (session?.serviceKind) {
        // Service session (tree-scoped machinery, e.g. the regen distiller):
        // the alembic marks it as read-only distillation machinery.
        prefixRuns.push({ text: "⚗ ", color: "magenta", bold: true });
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
    // Bracketed + bold so it reads as an owner badge, not part of the title.
    // The current viewer's own sessions get a distinct color so "mine" pops.
    if (shouldDecorateSessionOwners(state) && !session?.isSystem && !session?.isGroup) {
        const initials = effectiveOwner ? ownerInitials(effectiveOwner) : "?";
        const viewerKey = ownerKeyForOwner(state?.auth?.principal);
        const isMine = viewerKey && ownerKeyForOwner(effectiveOwner) === viewerKey;
        titleRuns.push({ text: `[${initials}] `, color: isMine ? "green" : "cyan", bold: true });
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
        // Shared-session marker (security model): private needs no marker;
        // shared_read/shared_write surface here in the selected-row details.
        if (session?.visibility === "shared_read" || session?.visibility === "shared_write") {
            pushSep();
            detailRuns.push({
                text: session.visibility === "shared_write" ? "shared·write" : "shared·read",
                color: "magenta",
            });
        }
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
        // Total descendants, for renderers that want the real number rather
        // than the collapse badge (which counts only HIDDEN children, so it is
        // null whenever the subtree is expanded).
        // NOTE: `detailRuns` above computes its own childCount by indexing this
        // Map with brackets, which always yields undefined — so its "N children"
        // segment has never rendered. Left alone deliberately: fixing it would
        // change TUI and mobile output.
        childCount: totalDescendantCounts?.get?.(session?.sessionId) || 0,
        // Structured row description for renderers that draw real chrome
        // instead of terminal runs (the portal's rich session list): status
        // becomes a dot, depth becomes indentation, the owner/child/cron
        // badges become chips. Purely additive — `runs`/`titleRuns` above
        // stay the terminal's source of truth and the TUI ignores this.
        chrome: {
            kind: session?.isGroup ? "group"
                : session?.isSystem ? "system"
                : session?.serviceKind ? "service"
                : "session",
            title: hasRealTitle ? rawTitle : shortId,
            untitled: !hasRealTitle,
            statusColor: sessionStatusColor(session, mode),
            accentColor: mainColor,
            pinned: isPinned,
            selectMode,
            checked: isSelected,
            owner: shouldDecorateSessionOwners(state) && !session?.isSystem && !session?.isGroup
                ? {
                    initials: effectiveOwner ? ownerInitials(effectiveOwner) : "?",
                    isMine: Boolean(ownerKeyForOwner(state?.auth?.principal)
                        && ownerKeyForOwner(effectiveOwner) === ownerKeyForOwner(state?.auth?.principal)),
                }
                : null,
            childBadge: collapseBadge ? { text: collapseBadge.text, color: collapseBadge.color } : null,
            cron: Boolean(cronBadge),
            age: relTime || null,
            model: modelLabel || null,
            shortId,
            ctx: ctxRuns.length > 0 ? { text: ctxRuns[0].text, color: ctxRuns[0].color } : null,
        },
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

// The transient deep-link filter exception covers the linked session AND its
// ancestor chain (real parents plus the synthetic group:<id> row) so the
// linked row renders with its tree context instead of as an orphan.
function collectFilterExceptionIds(sessions) {
    const exceptionId = sessions?.filterExceptionId || null;
    const byId = sessions?.byId || {};
    if (!exceptionId || !byId[exceptionId]) return null;
    const ids = new Set([exceptionId]);
    let current = byId[exceptionId];
    let hops = 0;
    while (current && hops < 16) {
        let parentId = null;
        if (current.parentSessionId && byId[current.parentSessionId]) {
            parentId = current.parentSessionId;
        } else if (!current.isGroup && current.groupId && byId[`group:${current.groupId}`]) {
            parentId = `group:${current.groupId}`;
        }
        if (!parentId || ids.has(parentId)) break;
        ids.add(parentId);
        current = byId[parentId];
        hops += 1;
    }
    return ids;
}

// Per-row memo, keyed by the `flat` list so it survives selection changes but
// resets whenever the tree itself is rebuilt.
//
// WHY: moving the selection re-runs this selector (once from moveSession, once
// from the portal's useMemo) and used to rebuild EVERY row — including
// flattenRunsText over each row's runs — to change one boolean on two of them.
// At fleet scale that is the cost of a keypress. Now only rows whose inputs
// actually moved are rebuilt, and the rest keep their previous object
// identity, which also lets the renderer skip them.
const sessionRowMemo = new WeakMap();

function sameRowDeps(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}

export function selectSessionRows(state) {
    const totalDescendantCounts = getTotalDescendantCounts(state.sessions.byId);
    const visibleDescendantCounts = getVisibleDescendantCounts(state.sessions.flat, state.sessions.byId);
    const query = normalizeSearchQuery(state.sessions?.filterQuery || "");
    const ownerFilter = state.sessions?.ownerFilter || { all: true };
    const auth = state.auth || {};
    const pinnedSet = new Set(Array.isArray(state.sessions?.pinnedIds) ? state.sessions.pinnedIds : []);
    const selectedSet = new Set(Array.isArray(state.sessions?.selectedIds) ? state.sessions.selectedIds : []);
    const filterExceptionIds = collectFilterExceptionIds(state.sessions);

    let memo = sessionRowMemo.get(state.sessions.flat);
    if (!memo) {
        memo = new Map();
        sessionRowMemo.set(state.sessions.flat, memo);
    }

    return state.sessions.flat.map((entry) => {
        const session = state.sessions.byId[entry.sessionId];
        const active = entry.sessionId === state.sessions.activeSessionId;
        const pinned = pinnedSet.has(entry.sessionId);
        const selected = selectedSet.has(entry.sessionId);
        // Every input the row below is derived from. Identity comparison is
        // enough: the reducer replaces these objects rather than mutating them.
        const deps = [
            entry, session, active, pinned, selected, query, ownerFilter, auth,
            state.connection?.mode, state.sessions.selectMode,
            totalDescendantCounts, visibleDescendantCounts,
            // The root system row renders as the branding title, and this
            // selector is called with two different state shapes (the portal
            // builds a synthetic one). Without this the cache could hand a row
            // built under one branding to a caller using another, and the root
            // session's name would flip between them.
            state.branding?.title,
        ];
        const cached = memo.get(entry.sessionId);
        if (cached && sameRowDeps(cached.deps, deps)) return cached.row;

        const rowView = buildSessionRowView(entry, session, state, totalDescendantCounts, visibleDescendantCounts);
        const row = {
            sessionId: entry.sessionId,
            text: flattenRunsText(rowView.runs),
            ...rowView,
            depth: entry.depth,
            status: session?.status,
            statusColor: sessionStatusColor(session, state.connection?.mode || "local"),
            active,
            isSystem: Boolean(session?.isSystem),
            isGroup: Boolean(session?.isGroup),
            hasChildren: entry.hasChildren,
            collapsed: entry.collapsed,
            pinned,
            selected,
            canPin: canPinSessionRow(session),
        };
        memo.set(entry.sessionId, { deps, row });
        return row;
    }).filter((row) => {
        if (filterExceptionIds?.has(row.sessionId)) return true;
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

export function selectNavigationIntent(state) {
    return state.sessions?.navigationIntent || null;
}

/**
 * Deep-link failure state for renderers. `not_found` deliberately covers both
 * unknown and inaccessible sessions (no existence oracle); network/server
 * failures keep a retryable flavor.
 */
export function selectNavigationError(state) {
    const intent = state.sessions?.navigationIntent;
    if (!intent || intent.status !== "failed") return null;
    const errorKind = intent.errorKind === "not_found" ? "not_found" : "network";
    return {
        sessionId: intent.sessionId,
        errorKind,
        retryable: errorKind === "network",
        message: errorKind === "not_found"
            ? "This session was not found or has not been shared with you."
            : "Could not load the linked session. Check your connection and try again.",
    };
}

/**
 * Status copy for the transient deep-link filter exception — non-null while a
 * linked session is being shown despite the current filters excluding it.
 */
export function selectSessionFilterExceptionNotice(state) {
    const exceptionId = state.sessions?.filterExceptionId || null;
    if (!exceptionId || !state.sessions?.byId?.[exceptionId]) return null;
    return "Showing linked session outside your current filters.";
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
            : item.phase === "rejected"
                ? "rejected"
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

// Header facts for one chat message — speaker label, label color, delivery
// glyph, and timestamp — extracted from buildChatMessagePrefix so the rich
// (block) chat renderer can consume the same labeling rules without the
// terminal run/prefix shape. Returns { time, glyph, glyphColor, roleLabel,
// roleColor }.
function describeChatMessageHeader(message, options = {}) {
    const time = formatTimestamp(message?.createdAt || message?.time);
    // A user.message is labeled from the CURRENT VIEWER's perspective: "You"
    // for the viewer's own messages, the sender's name for anyone else. When
    // the sender is the session owner, an "(owner)" tag is appended — so the
    // viewing owner sees "You (owner):" and everyone else sees "Alice (owner):".
    // A distinct color marks messages from other people.
    const sender = message?.sender;
    const senderKey = sender?.kind === "user" ? ownerKeyForOwner(sender) : null;
    const viewerKey = options?.viewerKey || null;
    const ownerKey = options?.ownerKey || null;
    // Only distinguish speakers / show the owner tag in a SHARED session — a
    // private solo session stays plain "You" / "Agent" (no noise).
    const sharedContext = options?.sharedContext === true;
    const isUser = message?.role === "user";
    const isSelf = isUser && senderKey && viewerKey && senderKey === viewerKey;
    const fromOtherPerson = sharedContext && isUser && senderKey && !isSelf;
    // Owner tag: the sender is the session owner (or, for a sender-less own
    // message, the viewer themselves is the owner).
    const senderIsOwner = sharedContext && isUser && ownerKey && (
        (senderKey && senderKey === ownerKey)
        || (!senderKey && viewerKey && viewerKey === ownerKey)
    );
    const ownerSuffix = senderIsOwner ? " (owner)" : "";

    const roleLabel = isUser
        ? ((fromOtherPerson ? (sender.display || sender.subject || "User") : "You") + ownerSuffix)
        : message?.role === "assistant"
            ? "Agent"
            : message?.role === "system"
                ? "System"
                : "PilotSwarm";

    // Delivery glyph for user messages:
    //   ○    pending  — client outbox, not yet durable
    //   ✓    queued   — durably enqueued, waiting for orchestration to drain
    //   x    cancelling — durable cancel requested, waiting for runtime outcome
    //   x    rejected — server refused the send (authz); auto-dropped shortly
    //   ✓✓   sent     — persisted as user.message in CMS, LLM has it
    //   ✓✓↻  redelivered — the runtime retried the turn and re-delivered this
    //        message to the model; timestamp shows the LATEST delivery
    let glyph = null;
    let glyphColor = null;
    if (message?.pendingPhase === "pending") {
        glyph = "○";
        glyphColor = "yellow";
    } else if (message?.pendingPhase === "queued") {
        glyph = "✓";
        glyphColor = "cyan";
    } else if (message?.pendingPhase === "cancelling" || message?.pendingPhase === "rejected") {
        glyph = "x";
        glyphColor = "red";
    } else if (message?.role === "user" && !message?.optimistic && !message?.pendingPhase) {
        if (message?.stopped) {
            // Delivered, but its turn was user-stopped mid-flight — the model
            // may not have acted on it. Amber prohibition ("no parking") sign.
            glyph = "⊘";
            glyphColor = "yellow";
        } else if (message?.redelivered) {
            // Delivered twice (worker retry replayed the turn). Amber so the
            // retry is visible without reading as a failure.
            glyph = "✓✓↻";
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
            : message?.pendingPhase === "cancelling" || message?.pendingPhase === "rejected"
                ? "red"
            : fromOtherPerson
                ? OTHER_PERSON_CHAT_LABEL_COLOR
            : message?.role === "user"
                ? USER_CHAT_LABEL_COLOR
        : message?.role === "assistant"
            ? "green"
            : message?.role === "system"
                ? "yellow"
                : "white";
    // `fromOtherPerson` lets renderers drop the speaker label for the
    // viewer's own messages and the agent's (a 1:1 chat needs no "You:" /
    // "Agent:" on every turn) while still naming OTHER humans in a shared
    // session, where attribution is the whole point.
    return { time, glyph, glyphColor, roleLabel, roleColor, fromOtherPerson };
}

function buildChatMessagePrefix(message, options = {}) {
    const { time, glyph, glyphColor, roleLabel, roleColor } = describeChatMessageHeader(message, options);
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
                    tableMode: options.tableMode,
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
            tableMode: options.tableMode,
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
    const prefix = options.skipPrefix ? [] : buildChatMessagePrefix(message, options);
    const attachmentChipLines = buildAttachmentChipLines(message, options);

    if (tintedMarkdownLines.length === 0) {
        const bare = prefix.length > 0 ? [prefix] : [];
        return attachmentChipLines.length > 0 ? [...bare, ...attachmentChipLines] : bare;
    }

    if (startsWithStructuredBlock(tintedMarkdownLines)) {
        const structured = prefix.length > 0 ? [prefix, ...tintedMarkdownLines] : tintedMarkdownLines;
        return attachmentChipLines.length > 0 ? [...structured, ...attachmentChipLines] : structured;
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
    renderedLines.push(...attachmentChipLines);
    return renderedLines;
}

// Image attachment chips under a message. In sentinel mode (browser portal)
// a single structured line carries the refs so the web renderer can show
// authenticated thumbnails; everywhere else (TUI) each file renders as a
// `[image: name · 312 KB]` text chip.
function buildAttachmentChipLines(message, options = {}) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (attachments.length === 0) return [];
    if (options.tableMode === "sentinel") {
        // message.id is `${sessionId}:${seq}` — the renderer needs the session
        // to fetch artifact bytes through the authenticated transport.
        const sessionId = String(message?.id || "").split(":")[0] || null;
        return [{ kind: "imageAttachments", sessionId, attachments }];
    }
    return attachments.map((attachment) => {
        const size = Number(attachment?.sizeBytes) || 0;
        const sizeLabel = size >= 1024 * 1024
            ? `${(size / (1024 * 1024)).toFixed(1)} MB`
            : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`;
        return [
            { text: "  ", color: null },
            { text: `[image: ${attachment.filename}${size > 0 ? ` · ${sizeLabel}` : ""}]`, color: "cyan" },
        ];
    });
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

// Recent selectChatLines results, compared by the IDENTITY of every input.
//
// This wraps the entire transcript to terminal lines, and it runs from
// scrollPane / scrollPaneTo / the visual-offset helpers — i.e. on every scroll
// action, to answer nothing more than "how many lines are there". Measured
// 1.6ms at 300 messages and 5.1ms at 1500, per scroll.
//
// Keyed on identities rather than fields on purpose: selectActiveChat is NOT a
// pure function of the chat array — it also appends a pending-question message,
// an answered-question message and a session-error message, and branches on
// ui.chatViewMode and branding. Anything derived from `session` therefore has
// to invalidate when `session` does, which identity comparison gives for free.
//
// `byId` is in the key for two reasons found by adversarial review, both of
// which produced visibly wrong output:
//
//   1. For a GROUP session, selectActiveChat ignores the group's own history
//      entirely and builds a Members table by scanning every OTHER session in
//      byId (title / status / shortSummary). Renaming a member changes none of
//      the group row's own aggregate counters, and the reducer PRESERVES a
//      session object's identity when nothing on it moved — so without byId the
//      table froze on the old titles indefinitely. (An earlier version of this
//      comment claimed the poll rebuilds the session object every time. It does
//      not, and that wrong assumption is what made the bug possible.)
//   2. This memo is module-level and shared by callers that pass DIFFERENT
//      state shapes: the TUI's ChatPane passes a synthetic single-session byId
//      while the controller's scroll math passes the real full state. Every
//      other key field can match between them, so whichever missed first
//      populated one entry for both, and the member list flipped depending on
//      call order. Distinct byId objects now key them apart.
const CHAT_LINES_MEMO_MAX = 4;
let chatLinesMemo = [];

export function selectChatLines(state, maxWidth = 80, options = {}) {
    const memoSessionId = state?.sessions?.activeSessionId ?? null;
    const memoKey = {
        sessionId: memoSessionId,
        session: memoSessionId ? state?.sessions?.byId?.[memoSessionId] ?? null : null,
        byId: state?.sessions?.byId ?? null,
        chat: state?.history?.bySessionId?.get?.(memoSessionId)?.chat ?? null,
        viewMode: state?.ui?.chatViewMode ?? null,
        branding: state?.branding ?? null,
        principal: state?.auth?.principal ?? null,
        maxWidth,
        tableMode: options?.tableMode ?? null,
    };
    for (const entry of chatLinesMemo) {
        if (entry.sessionId === memoKey.sessionId
            && entry.session === memoKey.session
            && entry.byId === memoKey.byId
            && entry.chat === memoKey.chat
            && entry.viewMode === memoKey.viewMode
            && entry.branding === memoKey.branding
            && entry.principal === memoKey.principal
            && Object.is(entry.maxWidth, memoKey.maxWidth)
            && entry.tableMode === memoKey.tableMode) {
            return entry.lines;
        }
    }

    const memoize = (lines) => {
        chatLinesMemo.unshift({ ...memoKey, lines });
        if (chatLinesMemo.length > CHAT_LINES_MEMO_MAX) chatLinesMemo.length = CHAT_LINES_MEMO_MAX;
        return lines;
    };

    const messages = selectActiveChat(state);
    if (!messages || messages.length === 0) {
        return memoize([{ text: "No messages yet.", color: "gray" }]);
    }

    // The current viewer's identity key — a user.message whose sender differs
    // is labeled with the sender's name (others) vs "You" (the viewer). The
    // session owner's messages additionally carry an "(owner)" tag.
    const viewerKey = ownerKeyForOwner(state?.auth?.principal);
    const activeSessionId = state?.sessions?.activeSessionId;
    const activeSession = activeSessionId ? state?.sessions?.byId?.[activeSessionId] : null;
    const ownerKey = ownerKeyForOwner(activeSession?.owner);
    // A shared context = the session is shared deployment-wide, or the viewer
    // is not its owner (someone shared it with them). Only then does the
    // transcript name speakers and tag the owner.
    const sharedContext = Boolean(activeSession && (
        (activeSession.visibility && activeSession.visibility !== "private")
        || (ownerKey && viewerKey && ownerKey !== viewerKey)
    ));
    const buildOptions = {
        ...(options?.tableMode ? { tableMode: options.tableMode } : {}),
        ...(viewerKey ? { viewerKey } : {}),
        ...(ownerKey ? { ownerKey } : {}),
        ...(sharedContext ? { sharedContext: true } : {}),
    };
    const lines = [];
    for (const [index, message] of messages.entries()) {
        if (message?.kind === "epoch-divider") {
            lines.push(buildEpochDividerLine(message, maxWidth));
        } else if (message?.kind === "regen-refused") {
            lines.push(buildRegenRefusedLine(message, maxWidth));
        } else if (message?.kind === "regen-failed") {
            lines.push(buildRegenFailedLine(message, maxWidth));
        } else {
            const messageLines = buildChatMessageLines(message, maxWidth, buildOptions);
            appendChatBlockLines(lines, messageLines);
        }
        const nextMessage = messages[index + 1];
        if (
            nextMessage
            && shouldInsertChatSpacer(message, nextMessage)
            && flattenLineText(lines[lines.length - 1]).trim().length > 0
        ) {
            lines.push(createBlankLine());
        }
    }
    return memoize(lines.length > 0 ? lines : [{ text: "No messages yet.", color: "gray" }]);
}

// True when a chat message is plain user/assistant prose the rich (block)
// renderer can format as markdown directly. Everything with terminal-era
// special handling — splash art, thinking cards, chrome-less summaries,
// system/PilotSwarm cards, asked-and-answered exchanges, embedded
// [SYSTEM: …] notice segments — stays on the line renderer, which already
// knows every edge case.
function isRichRenderableChatMessage(message) {
    if (!message) return false;
    if (message.kind === "epoch-divider" || message.kind === "regen-refused" || message.kind === "regen-failed") return false;
    if (message.splash || message.thinking || message.noChrome) return false;
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (message.role === "user" && parseAskedAndAnsweredExchange(message?.text || "")) return false;
    const segments = splitSystemNoticeSegments(message?.text || "");
    if (segments.some((segment) => segment.kind === "system")) return false;
    return true;
}

/**
 * Message-level view of the active chat for the rich (desktop-style) web
 * renderer. Returns an ordered array of blocks:
 *
 *   { kind: "message", id, role, header, text, pendingPhase, attachments }
 *     — plain user/assistant prose. `header` is describeChatMessageHeader()
 *       output; `text` is the artifact-link-decorated markdown source the
 *       renderer formats itself; `attachments` is { sessionId, attachments }
 *       (the sentinel shape) or null.
 *
 *   { kind: "lines", variant, lines }
 *     — everything else (splash, thinking cards, system cards, dividers),
 *       pre-rendered through the exact same line builders the terminal
 *       transcript uses, so no edge case has two implementations.
 *
 * The TUI never calls this; selectChatLines remains the terminal path.
 */
// Rich message blocks, cached on the message object. Keyed weakly so entries
// die with the transcript they came from.
const chatMessageBlockCache = new WeakMap();

export function selectChatBlocks(state, maxWidth = 80, options = {}) {
    const messages = selectActiveChat(state);
    if (!messages || messages.length === 0) return [];

    const viewerKey = ownerKeyForOwner(state?.auth?.principal);
    const activeSessionId = state?.sessions?.activeSessionId;
    const activeSession = activeSessionId ? state?.sessions?.byId?.[activeSessionId] : null;
    const ownerKey = ownerKeyForOwner(activeSession?.owner);
    const sharedContext = Boolean(activeSession && (
        (activeSession.visibility && activeSession.visibility !== "private")
        || (ownerKey && viewerKey && ownerKey !== viewerKey)
    ));
    const buildOptions = {
        ...(options?.tableMode ? { tableMode: options.tableMode } : {}),
        ...(viewerKey ? { viewerKey } : {}),
        ...(ownerKey ? { ownerKey } : {}),
        ...(sharedContext ? { sharedContext: true } : {}),
    };

    const blocks = [];
    for (const message of messages) {
        // Fast path FIRST. Classifying a message as rich-renderable scans its
        // text (asked-and-answered parsing, system-notice splitting), and that
        // ran for every message on every call — so a pane-splitter drag paid
        // it across the whole transcript per width step. A cache entry only
        // exists for a message already classified rich, and `kind` is part of
        // what is compared, so a hit is safe to take before classifying.
        // Object.is, NOT ===: `createdAt` is NaN whenever the source event had
        // no parseable timestamp, and NaN === NaN is false, so a plain equality
        // check could never hit for those messages — the cache would silently
        // do nothing while still costing a lookup. Same trap as comparing
        // Infinity by subtraction.
        const cached = message ? chatMessageBlockCache.get(message) : null;
        if (cached
            && Object.is(cached.text, message.text)
            && Object.is(cached.kind, message.kind)
            && Object.is(cached.role, message.role)
            && Object.is(cached.id, message.id)
            && Object.is(cached.pendingPhase, message.pendingPhase)
            && Object.is(cached.stopped, message.stopped)
            // The header is derived from these, and the chips from attachments.
            // Messages are mutated in place (pendingPhase provably is), so every
            // field the block is built from has to be compared — not just the
            // obvious ones.
            && Object.is(cached.createdAt, message.createdAt)
            && Object.is(cached.time, message.time)
            && Object.is(cached.sender, message.sender)
            && Object.is(cached.attachments, message.attachments)
            && Object.is(cached.tableMode, buildOptions.tableMode)
            && Object.is(cached.viewerKey, buildOptions.viewerKey)
            && Object.is(cached.ownerKey, buildOptions.ownerKey)
            && Object.is(cached.sharedContext, buildOptions.sharedContext)) {
            blocks.push(cached.block);
            continue;
        }

        if (message?.kind === "epoch-divider") {
            blocks.push({ kind: "lines", variant: "divider", lines: [buildEpochDividerLine(message, maxWidth)] });
            continue;
        }
        if (message?.kind === "regen-failed") {
            blocks.push({ kind: "lines", variant: "divider", lines: [buildRegenFailedLine(message, maxWidth)] });
            continue;
        }
        if (message?.kind === "regen-refused") {
            blocks.push({ kind: "lines", variant: "divider", lines: [buildRegenRefusedLine(message, maxWidth)] });
            continue;
        }
        if (isRichRenderableChatMessage(message)) {
            // A rich message block does NOT depend on maxWidth — the browser
            // wraps this text with CSS; only the terminal needs a column count.
            // Rebuilding it on every width step meant dragging a pane splitter
            // re-parsed artifact links and re-derived headers for the entire
            // loaded transcript to produce byte-identical output. Cache on the
            // message itself, keyed by the inputs that CAN change it.
            const attachmentLines = buildAttachmentChipLines(message, { tableMode: "sentinel" });
            const attachmentSentinel = attachmentLines.find((line) => line?.kind === "imageAttachments") || null;
            const block = {
                kind: "message",
                id: message?.id ?? null,
                role: message.role,
                header: describeChatMessageHeader(message, buildOptions),
                text: decorateArtifactLinksForChat(message?.text || ""),
                pendingPhase: message?.pendingPhase || null,
                attachments: attachmentSentinel
                    ? { sessionId: attachmentSentinel.sessionId, attachments: attachmentSentinel.attachments }
                    : null,
            };
            chatMessageBlockCache.set(message, {
                block,
                text: message.text,
                kind: message.kind,
                createdAt: message.createdAt,
                time: message.time,
                sender: message.sender,
                attachments: message.attachments,
                role: message.role,
                id: message.id,
                pendingPhase: message.pendingPhase,
                stopped: message.stopped,
                tableMode: buildOptions.tableMode,
                viewerKey: buildOptions.viewerKey,
                ownerKey: buildOptions.ownerKey,
                sharedContext: buildOptions.sharedContext,
            });
            blocks.push(block);
            continue;
        }
        const lineBlock = cachedLineBlock(message, maxWidth, buildOptions);
        if (lineBlock) blocks.push(lineBlock);
    }
    return blocks;
}

/**
 * Non-message blocks (thinking cards, system cards, splash, chrome-less
 * summaries) go through the terminal line builders, which DO depend on width —
 * so unlike message blocks these cannot be made width-independent. What they
 * can avoid is being rebuilt when the width has not moved, which is every poll:
 * the poll replaces `session`, the portal's useMemo sees a new selectorState,
 * and the whole transcript is re-derived. Measured at 1500 messages with 10%
 * line blocks that was 1.17ms a time, and 5.26ms at 50%.
 *
 * Only the LAST width is kept per message. A drag sweeps widths and will miss
 * on every step — that work is genuinely required, since these lines are
 * wrapped to a column count.
 *
 * The compared fields were enumerated from buildChatMessageLines and the
 * builders it delegates to (message/thinking/system-notice cards). `stopped` is
 * included because history.js sets it IN PLACE on an existing message.
 */
const chatLineBlockCache = new WeakMap();

function cachedLineBlock(message, maxWidth, buildOptions) {
    if (!message || typeof message !== "object") {
        const lines = buildChatMessageLines(message, maxWidth, buildOptions);
        return lines.length > 0 ? { kind: "lines", variant: "event", lines } : null;
    }
    const cached = chatLineBlockCache.get(message);
    if (cached
        && Object.is(cached.maxWidth, maxWidth)
        && Object.is(cached.text, message.text)
        && Object.is(cached.mobileText, message.mobileText)
        && Object.is(cached.role, message.role)
        && Object.is(cached.time, message.time)
        && Object.is(cached.createdAt, message.createdAt)
        && Object.is(cached.splash, message.splash)
        && Object.is(cached.thinking, message.thinking)
        && Object.is(cached.thinkingLabel, message.thinkingLabel)
        && Object.is(cached.progressKind, message.progressKind)
        && Object.is(cached.noChrome, message.noChrome)
        && Object.is(cached.cardTitle, message.cardTitle)
        && Object.is(cached.cardTitleColor, message.cardTitleColor)
        && Object.is(cached.cardBorderColor, message.cardBorderColor)
        && Object.is(cached.stopped, message.stopped)
        && Object.is(cached.tableMode, buildOptions.tableMode)
        && Object.is(cached.viewerKey, buildOptions.viewerKey)
        && Object.is(cached.ownerKey, buildOptions.ownerKey)
        && Object.is(cached.sharedContext, buildOptions.sharedContext)) {
        return cached.block;
    }
    const lines = buildChatMessageLines(message, maxWidth, buildOptions);
    const block = lines.length > 0 ? { kind: "lines", variant: "event", lines } : null;
    chatLineBlockCache.set(message, {
        block,
        maxWidth,
        text: message.text,
        mobileText: message.mobileText,
        role: message.role,
        time: message.time,
        createdAt: message.createdAt,
        splash: message.splash,
        thinking: message.thinking,
        thinkingLabel: message.thinkingLabel,
        progressKind: message.progressKind,
        noChrome: message.noChrome,
        cardTitle: message.cardTitle,
        cardTitleColor: message.cardTitleColor,
        cardBorderColor: message.cardBorderColor,
        stopped: message.stopped,
        tableMode: buildOptions.tableMode,
        viewerKey: buildOptions.viewerKey,
        ownerKey: buildOptions.ownerKey,
        sharedContext: buildOptions.sharedContext,
    });
    return block;
}

// A centered inline rule ("──── label ────") for transcript markers. The dash
// runs are CAPPED (not stretched to maxWidth): the web portal wraps by pixel
// width, and a maxWidth-long "─" run overflows a narrower pane and wraps the
// rule mid-label. A short symmetric rule reads as a divider on every width, and
// when the label alone will not fit it is rendered bare (wraps as plain text,
// never as dangling dash fragments).
function buildRuleLine(label, color, maxWidth) {
    const safeWidth = Math.max(24, Number(maxWidth) || 80);
    const room = safeWidth - label.length;
    if (room < 2) return [{ text: label.trim(), color, bold: true }];
    const perSide = Math.min(6, Math.floor(room / 2));
    if (perSide < 1) return [{ text: label.trim(), color, bold: true }];
    return [
        { text: "─".repeat(perSide), color },
        { text: label, color, bold: true },
        { text: "─".repeat(perSide), color },
    ];
}

// The inline transcript divider for a session-regeneration epoch flip — magenta,
// with the new epoch and the count of archived turns (proposal M2).
function buildEpochDividerLine(message, maxWidth) {
    const turns = Number.isFinite(message?.turnsArchived) ? message.turnsArchived : null;
    const label = ` ↻ context regenerated · epoch ${message?.epoch ?? "?"}`
        + `${turns != null ? ` · ${turns} turn${turns === 1 ? "" : "s"} archived` : ""} `;
    return buildRuleLine(label, "magenta", maxWidth);
}

// Friendly (compact) text for the orchestration's regenerate_refused reasons
// (lifecycle.ts). Kept short so the inline rule fits on one line.
const REGEN_REFUSED_REASONS = {
    cooldown: "on cooldown (once per 6h)",
    too_young: "too soon (needs 5+ turns)",
    already_pending: "already in progress",
    is_system: "not allowed for system sessions",
    not_owner: "owner only",
    not_parent: "parent only",
};

// The inline notice for a refused regeneration. Yellow (vs the magenta success
// divider) so a no-op attempt reads as a warning, correcting the tool's
// optimistic "regeneration accepted" acknowledgement.
function buildRegenRefusedLine(message, maxWidth) {
    const reason = String(message?.reason || "unknown");
    const text = REGEN_REFUSED_REASONS[reason] || reason.replace(/_/g, " ");
    const label = ` ↻ regeneration refused · ${text} `;
    return buildRuleLine(label, "yellow", maxWidth);
}

// A regeneration that was accepted then failed downstream. RED (vs yellow for
// a refusal): a refusal is the system declining on purpose, a failure is the
// pipeline breaking. Names the stage and the underlying cause, because the
// agent's own turn will have already claimed success from the optimistic ack.
function buildRegenFailedLine(message, maxWidth) {
    const stage = String(message?.stage || "unknown");
    const raw = String(message?.error || "").split("\n")[0];
    const cause = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
    const label = ` ✕ regeneration failed at ${stage}${cause ? ` · ${cause}` : ""} `;
    return buildRuleLine(label, "red", maxWidth);
}

export function selectOutboxOverlayLines(state, maxWidth = 80, options = {}) {
    const messages = selectActiveOutboxMessages(state);
    if (!messages || messages.length === 0) return [];

    const safeWidth = Math.max(20, Number(maxWidth) || 80);
    const queuedCount = messages.filter((message) => message.pendingPhase === "queued").length;
    const pendingCount = messages.filter((message) => message.pendingPhase === "pending").length;
    const cancellingCount = messages.filter((message) => message.pendingPhase === "cancelling").length;
    const rejectedCount = messages.filter((message) => message.pendingPhase === "rejected").length;
    const parts = [];
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (queuedCount > 0) parts.push(`${queuedCount} queued`);
    if (cancellingCount > 0) parts.push(`${cancellingCount} cancelling`);
    if (rejectedCount > 0) parts.push(`${rejectedCount} rejected`);
    const label = parts.length > 0 ? parts.join(" · ") : "queued prompts";
    const labelText = ` queued prompts: ${label} `;
    // The trailing rule is drawn by CSS, not by repeating "─" to a computed
    // character count. That count is derived from a pane width measured in
    // CHARACTERS, and when the estimate exceeds what actually fits — easily
    // triggered by a font-size change, or by probing a pane whose font differs
    // from this one — label + rule overflow and the rule wraps onto its own
    // line. A flex rule fills whatever space is really left, at any font size.
    const lines = [
        [
            { text: labelText, color: "gray", trailingRule: true },
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

/**
 * Worker details — the pane that REPLACES Activity while the Node Map is up.
 * Registry specs for the selected node, then the sessions executing on it.
 */
export function selectWorkerDetailsPane(state) {
    const view = selectNodeMapView(state);
    const node = view.selected ? view.nodes.find((candidate) => candidate.label === view.selected) : null;
    const title = buildPaneTitleRuns("Worker", "gray");
    if (!node) {
        title.push({ text: " none", color: "gray" });
        return {
            title,
            lines: [{
                text: view.degraded && view.registryError
                    ? `No worker selected — ${view.registryError}`
                    : "No workers to show yet.",
                color: "gray",
            }],
        };
    }
    title.push({ text: ` ${node.label}`, color: "cyan" });
    const lines = [];
    const spec = (label, value, color = "white") => {
        if (value === null || value === undefined || value === "") return;
        lines.push([{ text: `${label.padEnd(10)} `, color: "gray" }, { text: String(value), color }]);
    };
    if (node.registered) {
        spec("Node", node.workerNodeId);
        spec("Phase", node.phase, node.phase === "draining" ? "red" : node.phase === "starting" ? "yellow" : "green");
        spec("Pool", node.pool);
        if (node.owner) spec("Owner", node.owner);
        spec("Heartbeat", node.live ? `${node.agoText ?? "now"} · live` : `${node.agoText ?? "unknown"} · stale`, node.live ? "green" : "red");
        spec("Uptime", node.uptimeText);
        spec("Memory", [node.rssText ? `rss ${node.rssText}` : null, node.heapText ? `heap ${node.heapText}` : null].filter(Boolean).join(" · ") || null);
        spec("Loop p99", node.eventLoopText);
        spec("SDK", node.sdkVersion);
        spec("Runtime", node.substrate);
        if (node.capabilities.length) spec("Caps", node.capabilities.join(", "));
        if (node.consumes.length) spec("Consumes", node.consumes.join(", "));
        if (node.pkgEpoch !== null) {
            const ok = node.pkgInstalled.filter((pkg) => pkg.status === "ok").length;
            const bad = node.pkgInstalled.length - ok;
            spec("Packages", `epoch ${node.pkgEpoch} · ${ok} ok${bad ? ` · ${bad} error` : ""}`, bad ? "red" : "white");
            for (const pkg of node.pkgInstalled) {
                lines.push([
                    { text: "           ", color: "gray" },
                    { text: `${pkg.status === "error" ? "✗" : "✓"} `, color: pkg.status === "error" ? "red" : "green" },
                    { text: `${pkg.name}${pkg.semver ? `@${pkg.semver}` : ""}`, color: pkg.status === "error" ? "red" : "white" },
                ]);
                if (pkg.error) lines.push([{ text: `             ${pkg.error}`, color: "red" }]);
            }
            if (node.pkgLastError) lines.push([{ text: `           last refresh error: ${node.pkgLastError}`, color: "red" }]);
        }
    } else {
        lines.push({ text: "Not in the worker registry — derived from recent activity only.", color: "gray" });
    }
    lines.push({ text: "", color: "gray" });
    lines.push([{ text: `EXECUTING (${node.executing.length})`, color: "cyan", bold: true }]);
    for (const entry of node.executing) {
        lines.push(entry.active
            ? buildActiveHighlightLine(entry.text)
            : { text: entry.text, color: entry.color, bold: entry.bold });
    }
    if (node.executing.length === 0) {
        lines.push({ text: `Nothing executing in the ${view.windowLabel} window.`, color: "gray" });
    }
    return { title, lines };
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

/**
 * Artifacts in the order they appear in the CONVERSATION.
 *
 * The Files list is sorted for browsing (alphabetical); the transcript order is
 * the order the work actually happened in. Stepping through a preview opened
 * from a chat link should follow the conversation, not the filing cabinet — so
 * these are two distinct sequences and neither can be derived from the other.
 *
 * Ids are `<sessionId>/<filename>`, matching files.selectedArtifactId.
 */
export function selectChatOrderedArtifactIds(state) {
    const session = selectActiveSession(state);
    const sessionId = session?.sessionId;
    if (!sessionId) return [];
    const history = state.history?.bySessionId?.get?.(sessionId);
    const events = history?.events || [];
    const seen = new Set();
    const ordered = [];
    const re = /artifact:\/\/([a-f0-9-]+)\/([^\s"'{})\]]+)/g;
    for (const event of events) {
        const text = typeof event?.data?.content === "string" ? event.data.content : "";
        if (!text) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const id = `${m[1]}/${m[2]}`;
            if (seen.has(id)) continue;
            seen.add(id);
            ordered.push(id);
        }
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
function adminPkgDate(value) {
    if (!value) return "—";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function adminPkgSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function adminPkgLanguage(filePath) {
    const lower = String(filePath || "").toLowerCase();
    if (lower.endsWith(".md")) return "markdown";
    if (lower.endsWith(".json")) return "json";
    if (/\.(mjs|cjs|js)$/.test(lower)) return "javascript";
    return "text";
}

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

    // ── Agent packages view-model (Admin → Agents) ───────────────
    const pkgState = admin.packages || {};
    const pkgList = Array.isArray(pkgState.list) ? pkgState.list : [];
    const ownsPackage = (pkg) => Boolean(
        isAdmin
        || (pkg?.owner && principal
            && pkg.owner.provider === principal.provider
            && pkg.owner.subject === principal.subject),
    );
    const packageRow = (pkg) => ({
        name: pkg.name,
        scope: pkg.scope === "shared" ? "shared" : "user",
        enabled: Boolean(pkg.enabled),
        semver: pkg.active?.semver || null,
        sha7: pkg.active?.sha256 ? String(pkg.active.sha256).slice(0, 7) : null,
        agentCount: Array.isArray(pkg.active?.manifest?.agents) ? pkg.active.manifest.agents.length : 0,
        canManage: ownsPackage(pkg),
        // Highlight only while the Agents section is active — otherwise the
        // GitHub Keys screen shows a double selection.
        selected: admin.section === "packages" && pkgState.selectedName === pkg.name,
    });
    const sharedRows = pkgList.filter((pkg) => pkg.scope === "shared").map(packageRow);
    const userRows = pkgList.filter((pkg) => pkg.scope !== "shared").map(packageRow);

    // Settings tree — the session-list-slot navigation. Rendered by both
    // hosts; `kind` drives affordances (section rows switch panes, package
    // rows select a package).
    const section = ["packages", "workers"].includes(admin.section) ? admin.section : "ghcp";
    const settingsTree = [
        { id: "ghcp", kind: "section", depth: 0, label: "GitHub Keys", selected: section === "ghcp" },
        { id: "agents", kind: "section", depth: 0, label: "Agents", selected: section === "packages" && !pkgState.selectedName },
        { id: "group:shared", kind: "group", depth: 1, label: "Shared", count: sharedRows.length },
        ...sharedRows.map((row) => ({ id: `pkg:${row.name}`, kind: "package", depth: 2, label: row.name, ...row })),
        { id: "group:user", kind: "group", depth: 1, label: "User", count: userRows.length },
        ...userRows.map((row) => ({ id: `pkg:${row.name}`, kind: "package", depth: 2, label: row.name, ...row })),
        // The worker registry is a hard-gated admin read; hide the section
        // entirely from non-admins rather than showing a doomed pane.
        ...(isAdmin ? [{ id: "workers", kind: "section", depth: 0, label: "Workers", selected: section === "workers" }] : []),
    ];

    // Detail view-model for the selected package.
    const detail = pkgState.detail || null;
    let packageDetail = null;
    if (pkgState.selectedName) {
        const summary = pkgList.find((pkg) => pkg.name === pkgState.selectedName) || null;
        const activeVersion = detail?.versions?.find((v) => v.versionId === detail.activeVersionId) || null;
        const manifest = activeVersion?.manifest || summary?.active?.manifest || {};
        // Workers are ephemeral pods: rows for retired pod names linger until
        // the server-side prune, so fleet adoption counts only workers whose
        // heartbeat (updated_at, touched every ~20s poll) is fresh.
        const FLEET_LIVENESS_MS = 90_000;
        const liveCutoff = Date.now() - FLEET_LIVENESS_MS;
        const workerRows = (Array.isArray(pkgState.workerState) ? pkgState.workerState : [])
            .filter((worker) => {
                const at = worker?.updatedAt instanceof Date ? worker.updatedAt : new Date(worker?.updatedAt ?? 0);
                return !Number.isNaN(at.getTime()) && at.getTime() >= liveCutoff;
            });
        const fleetTotal = workerRows.length;
        const fleetCurrent = activeVersion
            ? workerRows.filter((worker) => worker.installed?.[pkgState.selectedName]?.semver === activeVersion.semver
                && worker.installed?.[pkgState.selectedName]?.status === "ok").length
            : 0;
        const canManage = detail ? ownsPackage(detail) : (summary ? ownsPackage(summary) : false);
        packageDetail = {
            name: pkgState.selectedName,
            loading: Boolean(pkgState.detailLoading),
            error: pkgState.detailError || null,
            scope: (detail?.scope || summary?.scope) === "shared" ? "shared" : "user",
            enabled: detail ? Boolean(detail.enabled) : Boolean(summary?.enabled),
            canManage,
            createdBy: detail?.createdBy || summary?.createdBy || null,
            createdAtText: adminPkgDate(detail?.createdAt || summary?.createdAt),
            description: typeof manifest.description === "string" ? manifest.description : "",
            activeSemver: activeVersion?.semver || summary?.active?.semver || null,
            activeSha12: activeVersion?.sha256 ? String(activeVersion.sha256).slice(0, 12) : null,
            sizeText: adminPkgSize(activeVersion?.sizeBytes ?? summary?.active?.sizeBytes),
            agents: Array.isArray(manifest.agents)
                ? manifest.agents.map((agent) => ({
                    name: agent.name,
                    description: agent.description || "",
                    toolCount: Array.isArray(agent.tools) ? agent.tools.length : 0,
                    skillCount: Array.isArray(agent.skills) ? agent.skills.length : 0,
                }))
                : [],
            versions: (detail?.versions || []).map((version) => ({
                semver: version.semver,
                sha12: String(version.sha256 || "").slice(0, 12),
                dateText: adminPkgDate(version.createdAt),
                active: version.versionId === detail?.activeVersionId,
            })),
            fleet: fleetTotal > 0 && activeVersion
                ? { current: fleetCurrent, total: fleetTotal, text: `${fleetCurrent}/${fleetTotal} workers current` }
                : null,
            actionPending: pkgState.action?.pending || null,
            actionError: pkgState.action?.error || null,
        };
    }

    // Workspace view-model: nested tree rows honoring expandedDirs + preview.
    const workspaceState = pkgState.workspace || {};
    let workspace = null;
    if (pkgState.selectedName) {
        const tree = workspaceState.tree;
        const expanded = new Set(workspaceState.expandedDirs || []);
        const treeRows = [];
        if (tree) {
            const visible = (relPath) => {
                const parts = relPath.split("/");
                for (let i = 1; i < parts.length; i++) {
                    if (!expanded.has(parts.slice(0, i).join("/"))) return false;
                }
                return true;
            };
            const treeDirs = Array.isArray(tree.dirs) ? tree.dirs : [];
            const treeFiles = Array.isArray(tree.files) ? tree.files : [];
            // Segment-aware sort: "/" must sort before every sibling char or a
            // dir separates from its children (agents/ vs agents-guide.md).
            const sortKey = (value) => String(value).split("/").join("\u0000");
            const nodes = [
                ...treeDirs.map((dir) => ({ type: "dir", path: dir })),
                ...treeFiles.map((file) => ({ type: "file", path: file.path, size: file.size })),
            ].sort((a, b) => (sortKey(a.path) < sortKey(b.path) ? -1 : 1));
            for (const node of nodes) {
                if (!visible(node.path)) continue;
                const depth = node.path.split("/").length - 1;
                treeRows.push({
                    type: node.type,
                    path: node.path,
                    label: node.path.split("/").pop() + (node.type === "dir" ? "/" : ""),
                    depth,
                    expanded: node.type === "dir" ? expanded.has(node.path) : undefined,
                    sizeText: node.type === "file" ? adminPkgSize(node.size) : null,
                    selected: workspaceState.selectedPath === node.path,
                });
            }
        }
        const file = workspaceState.file;
        workspace = {
            loading: Boolean(workspaceState.treeLoading),
            error: workspaceState.treeError || null,
            semver: workspaceState.tree?.semver || null,
            treeRows,
            file: file
                ? {
                    path: file.path,
                    sizeText: adminPkgSize(file.size),
                    truncated: Boolean(file.truncated),
                    isBinary: file.encoding === "base64",
                    text: file.encoding === "base64" ? null : String(file.content || ""),
                    language: adminPkgLanguage(file.path),
                }
                : null,
            fileLoading: Boolean(workspaceState.fileLoading),
            fileError: workspaceState.fileError || null,
            selectedPath: workspaceState.selectedPath || null,
        };
    }

    // ── Worker registry (Admin → Workers) ────────────────────────
    // Rows self-prune server-side after 1h; the UI additionally marks a
    // worker live only when its heartbeat is younger than the same 90s
    // window the fleet-adoption count uses.
    const workersState = admin.workers || {};
    const workerList = Array.isArray(workersState.list) ? workersState.list : [];
    const WORKERS_LIVE_MS = 90_000;
    const workersNow = Date.now();
    const workerAgo = (ms) => {
        if (!Number.isFinite(ms) || ms < 0) return "—";
        if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
        if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
        return `${Math.round(ms / 3_600_000)}h ago`;
    };
    const workerUptime = (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return null;
        if (seconds < 60) return `${Math.round(seconds)}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        const h = Math.floor(seconds / 3600);
        return h < 48 ? `${h}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
    };
    const workerRegistryRows = workerList
        .map((worker) => {
            const at = worker?.updatedAt instanceof Date ? worker.updatedAt : new Date(worker?.updatedAt ?? 0);
            const ageMs = Number.isNaN(at.getTime()) ? Number.NaN : workersNow - at.getTime();
            const health = worker?.health || {};
            const info = worker?.info || {};
            const pkg = worker?.state?.["agent-packages"] || null;
            const installed = pkg?.installed && typeof pkg.installed === "object" ? Object.values(pkg.installed) : [];
            const pkgErrors = installed.filter((entry) => entry?.status === "error").length;
            return {
                id: String(worker?.workerNodeId ?? ""),
                pool: String(worker?.pool ?? "default"),
                phase: ["starting", "ready", "draining"].includes(worker?.phase) ? worker.phase : "ready",
                live: Number.isFinite(ageMs) && ageMs <= WORKERS_LIVE_MS,
                agoText: workerAgo(ageMs),
                uptimeText: workerUptime(health.uptimeS),
                rssText: adminPkgSize(health.rssBytes),
                sessions: Number.isFinite(health.activeSessions) ? health.activeSessions : null,
                eventLoopText: Number.isFinite(health.eventLoopDelayP99Ms) ? `${health.eventLoopDelayP99Ms}ms` : null,
                sdkVersion: typeof info.sdkVersion === "string" ? info.sdkVersion : null,
                substrate: typeof info.runtime?.substrate === "string" ? info.runtime.substrate : null,
                consumes: Array.isArray(info.consumes) ? info.consumes : [],
                owner: worker?.owner?.subject ? String(worker.owner.subject) : null,
                pkgEpoch: Number.isFinite(pkg?.epoch) ? pkg.epoch : null,
                pkgText: pkg
                    ? `${installed.length - pkgErrors} ok${pkgErrors ? ` · ${pkgErrors} error` : ""}`
                    : null,
            };
        })
        .sort((a, b) => (a.pool === b.pool ? (a.id < b.id ? -1 : 1) : (a.pool < b.pool ? -1 : 1)));
    const liveWorkerRows = workerRegistryRows.filter((row) => row.live);
    const workersView = {
        loading: Boolean(workersState.loading),
        error: workersState.error || null,
        empty: workerRegistryRows.length === 0 && !workersState.loading,
        rows: workerRegistryRows,
        counts: {
            registered: workerRegistryRows.length,
            live: liveWorkerRows.length,
            ready: liveWorkerRows.filter((row) => row.phase === "ready").length,
            starting: liveWorkerRows.filter((row) => row.phase === "starting").length,
            draining: liveWorkerRows.filter((row) => row.phase === "draining").length,
            pools: [...new Set(liveWorkerRows.map((row) => row.pool))].length,
        },
        summaryText: workerRegistryRows.length
            ? `${liveWorkerRows.length} live / ${workerRegistryRows.length} registered`
            : null,
    };

    const packagesView = {
        loading: Boolean(pkgState.loading),
        error: pkgState.error || null,
        empty: pkgList.length === 0 && !pkgState.loading,
        sharedCount: sharedRows.length,
        userCount: userRows.length,
        selectedName: pkgState.selectedName || null,
        detail: packageDetail,
        workspace,
        addDialog: {
            open: Boolean(pkgState.addDialog?.open),
            kind: pkgState.addDialog?.kind || "repo",
            scope: pkgState.addDialog?.scope || "user",
            repoUrl: pkgState.addDialog?.repoUrl || "",
            ref: pkgState.addDialog?.ref || "",
            path: pkgState.addDialog?.path || "",
            url: pkgState.addDialog?.url || "",
            authToken: pkgState.addDialog?.authToken || "",
            submitting: Boolean(pkgState.addDialog?.submitting),
            progress: pkgState.addDialog?.progress || null,
            error: pkgState.addDialog?.error || null,
        },
    };

    const actions = [];
    if (section === "workers") {
        actions.push({ id: "workersRefresh", label: "Refresh workers", key: "r" });
        actions.push({ id: "showPackages", label: "Agents", key: "a" });
        actions.push({ id: "showGhcp", label: "GitHub Keys", key: "g" });
        actions.push({ id: "close", label: "Close console", key: "Esc" });
        return {
            visible: Boolean(admin.visible),
            loading: Boolean(admin.loading),
            loadError: admin.loadError || null,
            principal,
            isAdmin,
            section,
            settingsTree,
            packages: packagesView,
            workers: workersView,
            ghcpKey: {
                configured: Boolean(profile?.githubCopilotKeySet),
                targetConfigured,
                storeAsSystem,
                editing: false,
                draft: "",
                cursorIndex: 0,
                saving: false,
                error: null,
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
    if (section === "packages") {
        actions.push({ id: "packagesRefresh", label: "Refresh packages", key: "r" });
        actions.push({ id: "packagesNext", label: "Next package", key: "j" });
        actions.push({ id: "packagesPrev", label: "Previous package", key: "k" });
        actions.push({ id: "showGhcp", label: "GitHub Keys", key: "g" });
        actions.push({ id: "close", label: "Close console", key: "Esc" });
        return {
            visible: Boolean(admin.visible),
            loading: Boolean(admin.loading),
            loadError: admin.loadError || null,
            principal,
            isAdmin,
            section,
            settingsTree,
            packages: packagesView,
            workers: workersView,
            ghcpKey: {
                configured: Boolean(profile?.githubCopilotKeySet),
                targetConfigured,
                storeAsSystem,
                editing: false,
                draft: "",
                cursorIndex: 0,
                saving: false,
                error: null,
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

    if (section === "ghcp") {
        actions.splice(actions.length - 1, 0, { id: "showPackages", label: "Agents", key: "a" });
    }
    return {
        visible: Boolean(admin.visible),
        loading: Boolean(admin.loading),
        loadError: admin.loadError || null,
        principal,
        isAdmin,
        section,
        settingsTree,
        packages: packagesView,
        workers: workersView,
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
    if (state.ui.modal?.type === "shareSession") {
        return {
            left: "Share the selected session",
            right: "name [r|w] grants · -name revokes · enter apply · esc close",
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
        [FOCUS_REGIONS.SESSIONS]: `up/down switch · ctrl-u/ctrl-d page · ctrl-g move group · f filter · P pin · V select · d done · D delete · r refresh · t title · v visibility · S share · [/] resize pane · {/} columns · T themes · ? help · a linked items · drag copy · tab next pane · p prompt`,
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
    // Compact: the sequence TIME column is fixed-width, and the full form
    // truncates any dated row to "26 Jul …", losing the time entirely.
    const time = formatTimestampCompact(event?.createdAt);
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
        time: formatTimestampCompact(safeCreatedAtMs),
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

/**
 * Strip trailing pad from the last run of a sequence line.
 *
 * Every column is padded to colWidth for alignment, but the FINAL column's
 * trailing spaces align nothing — there is no column after them. With
 * `white-space: pre` those spaces occupy real width, so every line rendered at
 * exactly the computed width and the pane had zero tolerance for rounding
 * between "columns x char width" and its actual pixel width. The result was a
 * horizontal scrollbar that never went away, on content that visibly fit.
 */
function trimTrailingRunPad(runs) {
    const out = runs.slice();
    while (out.length > 0) {
        const last = out[out.length - 1];
        const trimmed = String(last.text ?? "").replace(/\s+$/, "");
        if (trimmed === "") { out.pop(); continue; }
        out[out.length - 1] = { ...last, text: trimmed };
        break;
    }
    return out;
}

/** Widest rendered line, so decoration never outruns real content. */
function sequenceLineWidth(line) {
    if (Array.isArray(line?.runs)) {
        return line.runs.reduce((n, r) => n + displayLength(String(r.text ?? "")), 0);
    }
    if (Array.isArray(line)) {
        return line.reduce((n, r) => n + displayLength(String(r.text ?? "")), 0);
    }
    return displayLength(String(line?.text ?? ""));
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
    return trimTrailingRunPad(runs);
}

function buildSequenceDividerLine(nodeLabels, timeWidth, colWidth, contentWidth = Infinity) {
    const full = `${"-".repeat(timeWidth)} ${nodeLabels.map(() => "─".repeat(colWidth)).join(" ")}`;
    // Clip to the widest real line: a full-width rule under short content is
    // itself enough to force the scrollbar this trimming exists to remove.
    return plainInspectorLine(
        Number.isFinite(contentWidth) ? full.slice(0, Math.max(timeWidth, contentWidth)) : full,
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

    return trimTrailingRunPad(runs);
}

function buildNodeMapHeaderLine(nodeLabels, colWidth) {
    const runs = [];
    nodeLabels.forEach((nodeLabel, index) => {
        if (index > 0) runs.push({ text: " ", color: null });
        runs.push({ text: padDisplayText(nodeLabel, colWidth), color: "white", bold: true });
    });
    return runs;
}

const SEQ_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
    // Size the TIME column to what is actually in it. A fixed 8 fits "20:10:19"
    // but silently truncates any dated row, which is precisely the row where
    // the date matters. Capped so one odd stamp cannot starve the lanes.
    const timeWidth = Math.min(13, Math.max(
        8,
        ...visibleEntries.map((entry) => displayLength(String(entry.time || ""))),
    ));
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

    // Decoration is sized to real content, never to the pane's nominal width:
    // a full-width rule under short content forces the very scrollbar the
    // trimming above exists to remove.
    const headerLine = buildSequenceHeaderLine(nodeLabels, timeWidth, colWidth);
    const contentWidth = lines.reduce(
        (widest, line) => Math.max(widest, sequenceLineWidth(line)),
        sequenceLineWidth(headerLine),
    );

    return {
        stickyLines: [
            ...statsLines,
            plainInspectorLine(`Window: ${recentWindow.label}`, "gray"),
            headerLine,
            buildSequenceDividerLine(nodeLabels, timeWidth, colWidth, contentWidth),
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
    const prefix = session?.isSystem ? "⚙ " : session?.serviceKind ? "⚗ " : `${sessionStatusIcon(session) || "."} `;
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

function nodeMapAgoText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
}

function nodeMapUptimeText(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    return h < 48 ? `${h}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function nodeMapSessionEntry(session, brandingTitle, active) {
    const label = session?.isSystem
        ? canonicalSystemTitle(session, brandingTitle)
        : (session?.title || shortSessionId(session?.sessionId));
    const prefix = session?.isSystem ? "⚙ " : session?.serviceKind ? "⚗ " : `${sessionStatusIcon(session) || "."} `;
    return {
        sessionId: session?.sessionId || null,
        text: `${prefix}${label}`,
        color: session?.isSystem ? "yellow" : sessionStatusColor(session),
        bold: Boolean(session?.isSystem),
        active: Boolean(active),
    };
}

/**
 * Node Map view-model — registry-first (docs/proposals/worker-registry.md).
 *
 * Nodes lead with the WORKER REGISTRY: every registered worker with phase,
 * pool, and health specs, unioned with any node seen in recent activity
 * history (covers deployments/credentials without registry access — the view
 * degrades to activity-derived nodes rather than going blank). Sessions map
 * onto nodes exactly the way the legacy grid mapped them: last known
 * workerNodeId in the recent window. Both hosts render from this one VM.
 */
export function selectNodeMapView(state) {
    const recentWindow = getRecentActivityWindow(state);
    const brandingTitle = state.branding?.title || "PilotSwarm";
    const activeSessionId = state.sessions.activeSessionId;
    const registry = Array.isArray(state.admin?.workers?.list) ? state.admin.workers.list : [];
    const now = Date.now();
    const NODE_LIVE_MS = 90_000;

    const byLabel = new Map();
    for (const worker of registry) {
        const label = shortNodeLabel(worker?.workerNodeId);
        if (!label) continue;
        const at = worker?.updatedAt instanceof Date ? worker.updatedAt.getTime() : new Date(worker?.updatedAt ?? 0).getTime();
        const ageMs = Number.isFinite(at) ? now - at : Number.NaN;
        const health = worker?.health || {};
        byLabel.set(label, {
            label,
            workerNodeId: String(worker?.workerNodeId ?? ""),
            registered: true,
            live: Number.isFinite(ageMs) && ageMs <= NODE_LIVE_MS,
            phase: ["starting", "ready", "draining"].includes(worker?.phase) ? worker.phase : "ready",
            pool: String(worker?.pool ?? "default"),
            agoText: nodeMapAgoText(ageMs),
            uptimeText: nodeMapUptimeText(health.uptimeS),
            rssText: Number.isFinite(health.rssBytes) ? adminPkgSize(health.rssBytes) : null,
            heapText: Number.isFinite(health.heapUsedBytes) ? adminPkgSize(health.heapUsedBytes) : null,
            eventLoopText: Number.isFinite(health.eventLoopDelayP99Ms) ? `${health.eventLoopDelayP99Ms}ms` : null,
            sessions: Number.isFinite(health.activeSessions) ? health.activeSessions : null,
            sdkVersion: typeof worker?.info?.sdkVersion === "string" ? worker.info.sdkVersion : null,
            substrate: typeof worker?.info?.runtime?.substrate === "string" ? worker.info.runtime.substrate : null,
            capabilities: worker?.info?.capabilities && typeof worker.info.capabilities === "object"
                ? Object.entries(worker.info.capabilities).filter(([, on]) => Boolean(on)).map(([cap]) => cap).sort()
                : [],
            consumes: Array.isArray(worker?.info?.consumes) ? worker.info.consumes : [],
            owner: worker?.owner?.subject ? String(worker.owner.subject) : null,
            pkgEpoch: Number.isFinite(worker?.state?.["agent-packages"]?.epoch) ? worker.state["agent-packages"].epoch : null,
            pkgInstalled: worker?.state?.["agent-packages"]?.installed && typeof worker.state["agent-packages"].installed === "object"
                ? Object.entries(worker.state["agent-packages"].installed).map(([name, entry]) => ({
                    name,
                    semver: entry?.semver ?? null,
                    status: entry?.status === "error" ? "error" : "ok",
                    error: entry?.error ? String(entry.error) : null,
                }))
                : [],
            pkgLastError: worker?.state?.["agent-packages"]?.lastError ? String(worker.state["agent-packages"].lastError) : null,
            executing: [],
        });
    }
    for (const label of buildNodeMapNodeUnionForWindow(state, recentWindow)) {
        if (byLabel.has(label)) continue;
        byLabel.set(label, {
            label, workerNodeId: null, registered: false, live: true,
            phase: null, pool: null, agoText: null, uptimeText: null,
            rssText: null, heapText: null, eventLoopText: null, sessions: null,
            sdkVersion: null, substrate: null, capabilities: [], consumes: [],
            owner: null, pkgEpoch: null, pkgInstalled: [], pkgLastError: null,
            executing: [],
        });
    }

    // Sessions → nodes: last known workerNodeId inside the recent window.
    let missingHistoryCount = 0;
    for (const sessionId of buildOrderedSessionIds(state)) {
        const session = state.sessions.byId[sessionId];
        if (!session) continue;
        const history = state.history.bySessionId.get(sessionId);
        if (!history?.events) missingHistoryCount += 1;
        const nodeLabel = getLastKnownSessionNode(history, recentWindow);
        const node = nodeLabel ? byLabel.get(nodeLabel) : null;
        if (!node) continue;
        node.executing.push(nodeMapSessionEntry(session, brandingTitle, sessionId === activeSessionId));
    }

    const nodes = Array.from(byLabel.values()).sort((a, b) => {
        if (a.registered !== b.registered) return a.registered ? -1 : 1;
        if (a.live !== b.live) return a.live ? -1 : 1;
        const poolCmp = String(a.pool ?? "~").localeCompare(String(b.pool ?? "~"));
        if (poolCmp !== 0) return poolCmp;
        return a.label.localeCompare(b.label);
    });
    nodes.forEach((node, index) => { node.ordinal = index + 1; });

    const registeredNodes = nodes.filter((node) => node.registered);
    // A node is always selected while the Node Map is up: the remembered
    // choice when it is still in the fleet, otherwise the first row. The
    // remembered value is never cleared, so switching away and back restores
    // it — and a worker that vanishes falls back instead of blanking.
    const remembered = state.ui?.nodeMapSelectedNode;
    const selected = (remembered && nodes.some((node) => node.label === remembered))
        ? remembered
        : (nodes[0]?.label ?? null);

    return {
        windowLabel: recentWindow.label,
        degraded: registeredNodes.length === 0,
        registryError: state.admin?.workers?.error || null,
        registryFetchedAt: state.admin?.workers?.fetchedAt || 0,
        registryLoading: Boolean(state.admin?.workers?.loading),
        registryAttempts: state.admin?.workers?.attempts || 0,
        registryLastAttemptAt: state.admin?.workers?.lastAttemptAt || 0,
        registryLastSkip: state.admin?.workers?.lastSkip || null,
        registered: registeredNodes.length,
        liveCount: registeredNodes.filter((node) => node.live).length,
        executingTotal: nodes.reduce((sum, node) => sum + node.executing.length, 0),
        missingHistoryCount,
        selected,
        nodes,
    };
}

function buildNodeMapLines(state, maxWidth, options = {}) {
    void options;
    const view = selectNodeMapView(state);
    if (view.nodes.length === 0) {
        return [plainInspectorLine(
            view.degraded
                ? `No workers registered and no worker activity in the ${view.windowLabel} window.`
                : `No worker activity in the ${view.windowLabel} window.`,
            "gray")];
    }

    const lines = [];
    lines.push([{
        text: view.degraded
            ? `Nodes (activity-derived) · window ${view.windowLabel}`
            : `Nodes · ${view.liveCount} live / ${view.registered} registered · window ${view.windowLabel}`,
        color: "gray",
    }]);
    if (view.degraded) {
        // Say WHY the registry is absent — three different failures used to
        // collapse into one silent "(activity-derived)" header.
        if (view.registryError) {
            lines.push([{ text: `! worker registry unavailable: ${view.registryError}`, color: "red" }]);
        } else if (view.registryFetchedAt) {
            lines.push([{ text: "registry reachable but EMPTY — no worker has heartbeated in the last hour", color: "yellow" }]);
        } else if (view.registryLoading) {
            lines.push([{ text: "registry request in flight… (times out red after 10s)", color: "yellow" }]);
        } else if (view.registryAttempts === 0) {
            // No attempt has EVER been recorded: the refresh call is not
            // reaching the controller at all (host wiring), which used to be
            // indistinguishable from "the fetch failed".
            lines.push([{ text: "registry refresh has NEVER been attempted in this tab — reload; if it persists the refresh call is not reaching the controller", color: "red" }]);
        } else {
            const ago = view.registryLastAttemptAt ? Math.round((Date.now() - view.registryLastAttemptAt) / 1000) : null;
            lines.push([{
                text: `registry attempted ${view.registryAttempts}× (last ${ago === null ? "?" : `${ago}s`} ago${view.registryLastSkip ? `, skipped: ${view.registryLastSkip}` : ""}) but no rows and no error — reload if this persists`,
                color: "yellow",
            }]);
        }
    }
    lines.push(plainInspectorLine("", "gray"));

    for (const node of view.nodes) {
        const isSelected = node.label === view.selected;
        const dot = node.live ? "●" : "○";
        const dotColor = !node.live ? "gray" : node.phase === "draining" ? "red" : node.phase === "starting" ? "yellow" : "green";
        const runs = [
            { text: isSelected ? "› " : "  ", color: "green", bold: isSelected, nodeSelect: node.label, nodeSelected: isSelected },
            { text: node.ordinal <= 9 ? `${node.ordinal} ` : "  ", color: "gray", nodeSelect: node.label },
            { text: `${dot} `, color: dotColor, nodeSelect: node.label },
            { text: node.label.padEnd(7), color: isSelected ? "white" : node.live ? "white" : "gray", bold: isSelected, nodeSelect: node.label },
        ];
        if (node.registered) {
            runs.push({ text: ` ${(node.phase || "").padEnd(8)}`, color: dotColor, nodeSelect: node.label });
            runs.push({ text: ` ${node.pool}`, color: "gray", nodeSelect: node.label });
            const specs = [
                node.executing.length ? `${node.executing.length} sess` : null,
                node.rssText, node.uptimeText ? `up ${node.uptimeText}` : null, node.agoText,
            ].filter(Boolean).join(" · ");
            if (specs) runs.push({ text: `  ${specs}`, color: "gray", nodeSelect: node.label });
        } else {
            runs.push({ text: "  activity only", color: "gray", nodeSelect: node.label });
            if (node.executing.length) runs.push({ text: ` · ${node.executing.length} sess`, color: "gray", nodeSelect: node.label });
        }
        lines.push(trimTrailingRunPad(runs));
    }

    lines.push(plainInspectorLine("", "gray"));
    lines.push(plainInspectorLine("Click a node (or press 1-9) — its details fill the pane below.", "gray"));

    if (view.missingHistoryCount > 0) {
        lines.push(plainInspectorLine(`Loading worker history for ${view.missingHistoryCount} session(s)…`, "gray"));
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
            const isDisabled = Boolean(model.disabled);
            const labelRuns = fitRuns([
                { text: "· ", color: "gray" },
                { text: model.modelName || model.qualifiedName || model.id, color: isDisabled ? "gray" : "white", bold: Boolean(model.isDefault) && !isDisabled },
                ...(model.cost ? [{ text: ` [${model.cost}]`, color: "gray" }] : []),
                ...(isDisabled ? [{ text: " ⊘ needs GitHub key", color: "yellow" }] : []),
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
            ...(selectedItem.disabled
                ? [[{ text: "Unavailable: requires a GitHub Copilot key. Add yours in the Admin console, then reopen this picker.", color: "yellow" }]]
                : []),
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
    // Items arrive pre-sorted Shared → My agents → Generic (controller);
    // emit a non-clickable heading row at each group boundary. rowItemIndexes
    // maps rendered rows back to item indexes (null = heading) — the same
    // mechanism the model picker uses.
    const GROUP_HEADINGS = { shared: "Shared", mine: "My agents", generic: "" };
    // Package-scope vocabulary only makes sense when packages exist: a pure
    // baked deployment keeps the classic flat list, no headings.
    const hasPackageItems = items.some((item) => item?.packageName);
    const rows = [];
    const rowItemIndexes = [];
    let lastGroup = null;
    items.forEach((item, index) => {
        const group = item?.group || "shared";
        if (hasPackageItems && group !== lastGroup) {
            const heading = GROUP_HEADINGS[group] ?? "";
            rows.push([{ text: heading ? `── ${heading} ──` : "──", color: "gray" }]);
            rowItemIndexes.push(null);
            lastGroup = group;
        }
        const isSelected = index === selectedIndex;
        const suffix = item?.kind === "generic"
            ? " [generic]"
            : item?.packageName
                ? ` ${item.packageName} ${item.packageSemver || ""}`.trimEnd()
                : ` (${item?.agentName || item?.id || "agent"})`;
        const labelRuns = fitRuns([
            { text: item?.kind === "generic" ? "○ " : "· ", color: "gray" },
            { text: item?.title || item?.agentName || item?.id || "Agent", color: "white", bold: true },
            { text: suffix, color: "gray" },
        ], contentWidth);
        rows.push(isSelected
            ? buildActiveHighlightLine(labelRuns.map((run) => run.text).join("").padEnd(contentWidth, " "))
            : labelRuns);
        rowItemIndexes.push(index);
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
            ...(selectedItem.packageName
                ? [[{ text: `Package: ${selectedItem.packageName}@${selectedItem.packageSemver || "?"} · ${selectedItem.packageScope || "shared"}`, color: "gray" }]]
                : (selectedItem.kind === "agent" ? [[{ text: "Built-in agent", color: "gray" }]] : [])),
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

    const selectedRowIndex = rowItemIndexes.indexOf(selectedIndex);
    return {
        title: modal.title || "Select agent for new session",
        rows,
        rowItemIndexes,
        selectedRowIndex: selectedRowIndex >= 0 ? selectedRowIndex : 0,
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
    const selectedLabel = selectedItem?.label || selectedItem?.id;
    const detailsLines = [
        [{ text: modelItem?.modelName || modelItem?.qualifiedName || "Selected model", color: "white", bold: true }],
        [{ text: `${modelItem?.providerId || "provider"} (${modelItem?.providerType || "provider"})`, color: "gray" }],
        [{ text: "", color: "gray" }],
        [{ text: selectedLabel ? `Using context window: ${selectedLabel}` : "Choose a context window.", color: "white" }],
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

export function selectShareSessionModal(state, maxWidth = 76) {
    const modal = state.ui.modal;
    if (!modal || modal.type !== "shareSession") return null;

    const value = String(modal.value || "");
    const shares = Array.isArray(modal.shares) ? modal.shares : [];
    const detailsLines = [
        [{
            text: "General: ",
            color: "gray",
        }, {
            text: String(modal.visibility || "private"),
            color: "white",
            bold: true,
        }],
        ...(shares.length === 0
            ? [[{ text: "No individual grants.", color: "gray" }]]
            : shares.map((row) => [{
                text: `${row.displayName || row.subject}  `,
                color: "white",
            }, {
                text: `can ${row.access}`,
                color: "gray",
            }])),
    ];

    return {
        title: modal.title || "Share Session",
        value,
        cursorIndex: Math.max(0, Math.min(Number(modal.cursorIndex) || 0, value.length)),
        placeholder: "Name, email, or id",
        helpTitle: "Share Rules",
        helpLines: [
            [{
                text: "name-or-email [r|w] grants · -name revokes · Enter apply · Esc close",
                color: "gray",
            }],
            [{
                text: "Grantee needn't have signed in — an email grant binds at their first sign-in.",
                color: "gray",
            }],
        ],
        detailsLines,
        idealWidth: Math.min(
            Math.max(
                56,
                ...detailsLines.map((line) => flattenRunsLength(line) + 6),
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
    if (item.kind === "shared") return ownerFilter?.includeShared === true;
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

export function formatCompactNumber(n) {
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

    // Persistence card. Epoch (session-regeneration incarnation) is always
    // shown — 0 for a session that has never regenerated — so the current
    // epoch is visible at a glance; regen counters appear once it has.
    const regenCount = Number(summary.regenCount) || 0;
    const lastRegen = summary.lastRegenStats && typeof summary.lastRegenStats === "object" ? summary.lastRegenStats : null;
    const currentEpoch = Number.isFinite(lastRegen?.toEpoch) ? lastRegen.toEpoch : regenCount;
    // Distillation provenance: "fast" = deterministic package; otherwise the
    // distiller model label (strip the provider: prefix for width).
    const distillLabel = lastRegen
        ? (lastRegen.distillMode === "deterministic" || (!lastRegen.distillMode && !lastRegen.distillerModel)
            ? "fast"
            : String(lastRegen.distillerModel || "llm").replace(/^[^:]*:/, ""))
        : null;
    const lastRegenLabel = lastRegen
        ? `${lastRegen.turnsArchived ?? 0} turn${lastRegen.turnsArchived === 1 ? "" : "s"} · ${(Number(lastRegen.totalMs) / 1000).toFixed(1)}s${distillLabel ? ` · ${distillLabel}` : ""}`
        : null;
    lines.push(...buildMessageCardLines({
        title: "Persistence",
        body: formatKeyValueTable([
            ["Epoch",           String(currentEpoch)],
            ["Regens",          regenCount > 0 ? String(regenCount) : null],
            ["Last Regen",      lastRegenLabel],
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
        ["v", "fullscreen the focused pane (sessions pane: cycle visibility)"],
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
        ["v", "cycle visibility (private / shared read / shared write)"],
        ["S", "share — grant / revoke individual access"],
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
