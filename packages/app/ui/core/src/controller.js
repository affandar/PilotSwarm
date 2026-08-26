import { UI_COMMANDS, FOCUS_REGIONS, INSPECTOR_TABS, cycleValue } from "./commands.js";
import { BUDGET_SERIES_DAYS, BUDGET_SERIES_RANGES, canvasKey as canvasPrefKey } from "./state.js";
import { parseAgentSourceLink } from "./repo-links.js";
import { importPackageFilesFromLink, readImportedPackageName } from "./repo-import.js";
import {
    appendEventToHistory,
    buildHistoryModel,
    CHAT_HISTORY_EVENT_TYPES,
    DEFAULT_HISTORY_EVENT_LIMIT,
    dedupeChatMessages,
    getNextHistoryEventLimit,
} from "./history.js";
import { applySessionUsageEvent, cloneContextUsageSnapshot } from "./context-usage.js";
import { validateCanvasAction, formatCanvasActionPrompt, createCanvasActionLimiter } from "./canvas-actions.js";
import { shouldKeepRecoverableTransportWarning } from "./session-errors.js";
import {
    computeLegacyLayout,
    getBaseSessionPaneHeight,
    getFocusLeftTarget,
    getFocusOrderForLayout,
    getMaxSessionPaneHeight,
    getFocusRightTarget,
    getPromptInputRows,
    MIN_SESSION_PANE_HEIGHT,
    MIN_CHAT_PANE_HEIGHT,
    MIN_ACTIVITY_PANE_HEIGHT,
    MIN_INSPECTOR_PANE_HEIGHT,
    DEFAULT_ACTIVITY_PANE_RATIO,
    DEFAULT_LEFT_PANE_RATIO,
    COLLAPSE_RIGHT_THRESHOLD,
    normalizeFocusRegion,
} from "./layout.js";
import { parseTerminalMarkupRuns } from "./formatting.js";
import {
    selectActiveArtifactLinks,
    selectActiveHttpLinks,
    selectActivityPane,
    selectLiveActivityLines,
    selectChatLines,
    selectFileBrowserItems,
    selectChatOrderedArtifactIds,
    selectFileSessionIdsForScope,
    selectFilesScope,
    selectFilesView,
    selectInspector,
    selectOutboxOverlayLines,
    selectAdminConsole,
    selectSessionRows,
    selectSelectedFileBrowserItem,
    selectVisibleSessionRows,
} from "./selectors.js";
import { findArtifactEntry } from "./state.js";
import { getTheme, listThemes } from "./themes/index.js";

/**
 * The copy selector for a package LIST row: which same-named copy it is.
 * Scope shadowing means one name can be a shared package AND a user copy at
 * once; the row's scope (+ owner, for admins looking at someone else's user
 * copy) is what disambiguates every read and action on it.
 */
export function packageRowSelector(row) {
    if (!row) return null;
    return {
        ...(row.scope === "shared" || row.scope === "user" ? { scope: row.scope } : {}),
        ...(row.scope === "user" && row.owner?.provider && row.owner?.subject
            ? { owner: { provider: row.owner.provider, subject: row.owner.subject } }
            : {}),
    };
}

const ORCHESTRATION_STATS_REFRESH_MS = 20_000;
const SESSION_STATS_REFRESH_MS = 20_000;
const FLEET_STATS_REFRESH_MS = 30_000;
const FLEET_STATS_DEFAULT_WINDOW_DAYS = 30;
const SESSION_REFRESH_FAILED_STATUS = "Session refresh failed";
const AUTO_HISTORY_SCROLL_PAGE_COUNT = 3;
const SESSION_REFRESH_PAGE_LIMIT = 200;
const SESSION_REFRESH_MAX_PAGES = 5;
const FULLSCREENABLE_PANES = new Set([
    FOCUS_REGIONS.SESSIONS,
    FOCUS_REGIONS.CHAT,
    FOCUS_REGIONS.INSPECTOR,
    FOCUS_REGIONS.ACTIVITY,
]);

function sessionGroupToRow(group) {
    if (!group?.groupId) return null;
    const latestSummaryUpdatedAt = group.latestSummaryUpdatedAt
        ? new Date(group.latestSummaryUpdatedAt).getTime()
        : null;
    const memberCount = group.memberCount ?? 0;
    return {
        sessionId: `group:${group.groupId}`,
        groupId: group.groupId,
        isGroup: true,
        title: group.title || group.groupId,
        status: "group",
        description: group.description ?? null,
        owner: group.owner ?? null,
        shortSummary: `${memberCount} grouped session${memberCount === 1 ? "" : "s"}`,
        summaryUpdatedAt: Number.isFinite(latestSummaryUpdatedAt) ? latestSummaryUpdatedAt : null,
        latestSummaryUpdatedAt: Number.isFinite(latestSummaryUpdatedAt) ? latestSummaryUpdatedAt : null,
        memberCount,
        runningCount: group.runningCount ?? 0,
        waitingCount: group.waitingCount ?? 0,
        completedCount: group.completedCount ?? 0,
        failedCount: group.failedCount ?? 0,
        cancelledCount: group.cancelledCount ?? 0,
        createdAt: group.createdAt ? new Date(group.createdAt).getTime() : 0,
        updatedAt: group.updatedAt ? new Date(group.updatedAt).getTime() : Date.now(),
    };
}

function normalizeSessionListRow(session) {
    if (!session?.sessionId) return session;
    if (session.isGroup) return session;
    return {
        ...session,
        // The wire DTO carries the viewer-private placement as viewerGroupId;
        // the local groupId field is what the tree/selectors key off.
        groupId: session.viewerGroupId ?? null,
        parentSessionId: session.parentSessionId ?? null,
    };
}

function sessionGroupIdFromRowId(sessionId) {
    return String(sessionId || "").startsWith("group:") ? String(sessionId).slice("group:".length) : null;
}

// A folder's row id ("group:<uuid>") is a CLIENT-SIDE row, not a session. Feed
// one to a per-session endpoint and the server correctly answers 404 — which
// the data loops read as "this session was deleted" and evict the row. The
// folder then vanished a few ms after every refresh re-added it, and its
// members reflowed under the folder above. Every per-session path must skip
// these ids.
function isSessionGroupRowId(sessionId) {
    return sessionGroupIdFromRowId(sessionId) !== null;
}

// Per-row placement skip reasons ('system', 'not_found') folded into a short
// status-bar suffix, e.g. "2 system, 1 not found".
function summarizePlacementSkips(rows) {
    const counts = new Map();
    for (const row of rows || []) {
        const label = row?.reason === "system" ? "system" : "not found";
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(", ");
}

// Deep-link load failures split into two renderable kinds: a definitive
// not-found/no-access answer from the server (the API deliberately returns
// identical shapes for unknown vs unshared sessions), and everything else —
// network/server faults — which stays retryable.
function classifyNavigationLoadError(error) {
    const status = Number(error?.status);
    const code = String(error?.code || "").toUpperCase();
    if (status === 404 || status === 403 || code === "NOT_FOUND" || code === "FORBIDDEN") {
        return "not_found";
    }
    return "network";
}

// A 404/NOT_FOUND on a per-session data loop is TERMINAL: the session was
// deleted (here or elsewhere) and every retry will 404 forever. 403 stays
// retryable — a transient auth blip must not evict a live pane.
function isSessionGoneError(error) {
    const status = Number(error?.status);
    const code = String(error?.code || "").toUpperCase();
    return status === 404 || code === "NOT_FOUND";
}

async function loadSessionCatalogPageWindow(transport) {
    if (typeof transport.listSessionsPage !== "function") {
        return transport.listSessions();
    }

    const sessions = [];
    let cursor = null;
    for (let pageIndex = 0; pageIndex < SESSION_REFRESH_MAX_PAGES; pageIndex += 1) {
        const page = await transport.listSessionsPage({
            limit: SESSION_REFRESH_PAGE_LIMIT,
            cursor,
        });
        const pageSessions = Array.isArray(page?.sessions) ? page.sessions : [];
        sessions.push(...pageSessions);
        if (!page?.hasMore || !page?.nextCursor) break;
        cursor = page.nextCursor;
    }
    return sessions;
}

function groupModelsByProvider(models = []) {
    const groups = [];
    const byProvider = new Map();

    for (const model of models) {
        const providerId = model?.providerId || "models";
        let group = byProvider.get(providerId);
        if (!group) {
            group = {
                providerId,
                providerType: model?.providerType || "provider",
                models: [],
            };
            byProvider.set(providerId, group);
            groups.push(group);
        }
        group.models.push(model);
    }

    return groups;
}

/**
 * Where the model picker lands.
 *
 * Never on a model that cannot run: when the preferred one (usually the
 * default) is blocked, land on the first usable model instead, so the very
 * first Enter does something.
 */
function pickerSelectedIndex(items, preferredModel) {
    let index = items.findIndex((item) => item.qualifiedName === preferredModel && !item.disabled);
    if (index < 0) index = items.findIndex((item) => !item.disabled);
    return index < 0 ? 0 : index;
}

function normalizeReasoningEfforts(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    for (const raw of values) {
        const value = String(raw || "").trim().toLowerCase();
        if (!value || out.includes(value)) continue;
        out.push(value);
    }
    return out;
}

function resolveDefaultReasoningEffort(model) {
    const supported = normalizeReasoningEfforts(model?.supportedReasoningEfforts);
    if (supported.length === 0) return null;
    const candidate = String(model?.defaultReasoningEffort || "").trim().toLowerCase();
    if (candidate && supported.includes(candidate)) return candidate;
    if (supported.includes("medium")) return "medium";
    return supported[0] || null;
}

function normalizeContextTiers(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    for (const raw of values) {
        const value = String(raw || "").trim().toLowerCase();
        if (!value || out.includes(value)) continue;
        if (value !== "default" && value !== "long_context") continue;
        out.push(value);
    }
    return out;
}

function resolveDefaultContextTier(model) {
    const supported = normalizeContextTiers(model?.supportedContextTiers);
    if (supported.length === 0) return null;
    const candidate = String(model?.defaultContextTier || "").trim().toLowerCase();
    if (candidate && supported.includes(candidate)) return candidate;
    // Default to the smaller window.
    if (supported.includes("default")) return "default";
    return supported[0] || null;
}

const CONTEXT_TIER_LABELS = {
    default: "Default (smaller window)",
    long_context: "Long context (larger window, higher cost)",
};

function formatContextWindowSize(value) {
    const tokens = Number(value);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return null;
    if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
    if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
    return tokens.toLocaleString("en-US");
}

function formatContextTierLabel(tier, tokenLimit) {
    const size = formatContextWindowSize(tokenLimit);
    if (!size) return CONTEXT_TIER_LABELS[tier] || tier;
    return tier === "long_context"
        ? `Long context (${size} tokens, higher cost)`
        : `Default (${size} tokens)`;
}

function extractSessionModelFromEvents(events = []) {
    // Only explicit model-change events may update the session's model.
    // Deriving it from any event that happens to carry a `model` field lets
    // transient payloads (e.g. sub-activities reporting the default model)
    // flap the row between the configured model and the default, with the
    // periodic list/detail syncs flipping it back. The CMS session row is the
    // source of truth; session.model_changed is the only event that alters it.
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.eventType !== "session.model_changed") continue;
        const data = event?.data;
        if (!data || typeof data !== "object") continue;
        const model = typeof data.newModel === "string" && data.newModel
            ? data.newModel
            : (typeof data.model === "string" && data.model ? data.model : undefined);
        if (!model) continue;
        return {
            model,
            // newReasoningEffort travels with the switch; null means cleared.
            ...(typeof data.newReasoningEffort === "string" || data.newReasoningEffort === null
                ? { reasoningEffort: data.newReasoningEffort }
                : {}),
        };
    }
    return undefined;
}

function extractSessionModelFromEvent(event) {
    return extractSessionModelFromEvents([event]);
}

function extractSessionContextUsageFromEvents(initialContextUsage, events = []) {
    let current = cloneContextUsageSnapshot(initialContextUsage);
    for (const event of events) {
        const next = applySessionUsageEvent(current, event?.eventType, event?.data, {
            timestamp: event?.createdAt,
        });
        if (next) current = next;
    }
    return current;
}

function areStructuredValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!areStructuredValuesEqual(left[index], right[index])) return false;
        }
        return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!areStructuredValuesEqual(left[key], right[key])) return false;
    }
    return true;
}

function timestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

function isSameOrOlderSessionUpdate(previousSession, nextSession) {
    const previousUpdatedAt = timestampMs(previousSession?.updatedAt);
    const nextUpdatedAt = timestampMs(nextSession?.updatedAt);
    return previousUpdatedAt > 0 && nextUpdatedAt > 0 && nextUpdatedAt <= previousUpdatedAt;
}

function isIdleLikeSessionStatus(status) {
    return !status || status === "idle" || status === "unknown" || status === "pending";
}

function shouldPreserveStaleWaitingVisual(previousSession, nextSession) {
    return previousSession?.status === "waiting"
        && typeof previousSession?.waitReason === "string"
        && previousSession.waitReason.trim().length > 0
        && (nextSession?.waitReason === undefined || nextSession?.waitReason === null)
        && isIdleLikeSessionStatus(nextSession?.status)
        && isSameOrOlderSessionUpdate(previousSession, nextSession);
}

function shouldPreserveStaleCronVisual(previousSession, nextSession) {
    return previousSession?.cronActive === true
        && nextSession?.cronActive !== true
        && !isTerminalSessionStatus(nextSession?.status)
        && !isTerminalOrchestrationStatus(nextSession?.orchestrationStatus)
        && isSameOrOlderSessionUpdate(previousSession, nextSession);
}

function buildSessionMergePatch(previousSession, nextSession) {
    if (!nextSession?.sessionId) return null;

    const patch = { sessionId: nextSession.sessionId };
    let changed = false;
    for (const [key, value] of Object.entries(nextSession)) {
        if (key === "sessionId" || value === undefined) continue;
        if (areStructuredValuesEqual(previousSession?.[key], value)) continue;
        patch[key] = value;
        changed = true;
    }

    if (nextSession.pendingQuestion === undefined && previousSession?.pendingQuestion && nextSession.status !== "input_required"
        && !isSameOrOlderSessionUpdate(previousSession, nextSession)) {
        // Only a genuinely newer update may clear a pending question. A stale or
        // in-flight detail-sync that raced the input_required_started event (and
        // so still reports the pre-question status with no pendingQuestion) must
        // not wipe the question the user is looking at.
        patch.pendingQuestion = null;
        changed = true;
    }
    const preserveWaitingVisual = shouldPreserveStaleWaitingVisual(previousSession, nextSession);
    if (preserveWaitingVisual) {
        if (patch.status !== previousSession.status) {
            patch.status = previousSession.status;
            changed = true;
        }
        if (patch.waitReason !== previousSession.waitReason) {
            patch.waitReason = previousSession.waitReason;
            changed = true;
        }
    } else if (nextSession.waitReason === undefined && previousSession?.waitReason && nextSession.status !== "waiting" && nextSession.status !== "input_required") {
        patch.waitReason = null;
        changed = true;
    }
    if (shouldKeepRecoverableTransportWarning(previousSession, nextSession)) {
        if (patch.error !== previousSession.error) {
            patch.error = previousSession.error;
            changed = true;
        }
    } else if (nextSession.error === undefined && previousSession?.error && nextSession.status !== "failed" && nextSession.status !== "error") {
        patch.error = null;
        changed = true;
    }
    if (nextSession.result === undefined && previousSession?.result && nextSession.status !== "completed") {
        patch.result = null;
        changed = true;
    }
    const preserveCronVisual = shouldPreserveStaleCronVisual(previousSession, nextSession);
    if (preserveCronVisual) {
        for (const key of ["cronActive", "cronKind", "cronInterval", "cronReason", "cronNextFireAt", "cronTimezone", "cronMaxFires", "cronFiresCompleted"]) {
            if (previousSession?.[key] == null) continue;
            if (areStructuredValuesEqual(patch[key], previousSession[key])) continue;
            patch[key] = previousSession[key];
            changed = true;
        }
    } else if (nextSession.cronActive !== true) {
        if (previousSession?.cronReason) {
            patch.cronReason = null;
            changed = true;
        }
        for (const key of ["cronKind", "cronNextFireAt", "cronTimezone", "cronMaxFires", "cronFiresCompleted"]) {
            if (previousSession?.[key] != null && nextSession[key] === undefined) {
                patch[key] = null;
                changed = true;
            }
        }
        if (previousSession?.cronInterval != null && nextSession.cronInterval === undefined) {
            patch.cronInterval = null;
            changed = true;
        }
    }

    const terminalSession = isTerminalSessionStatus(nextSession.status) || isTerminalOrchestrationStatus(nextSession.orchestrationStatus);
    if (
        terminalSession
        && previousSession?.contextUsage?.compaction?.state === "running"
        && nextSession.contextUsage === undefined
    ) {
        const nextContextUsage = { ...previousSession.contextUsage };
        delete nextContextUsage.compaction;
        patch.contextUsage = Object.keys(nextContextUsage).length > 0 ? nextContextUsage : null;
        changed = true;
    }

    return changed ? patch : null;
}

function normalizeOutboxPromptText(text) {
    return String(text || "").replace(/\r\n/g, "\n").trim();
}

function isTerminalOrchestrationStatus(status) {
    return status === "Completed" || status === "Failed" || status === "Terminated";
}

function isTerminalSessionStatus(status) {
    return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalSendError(error) {
    const message = String(error?.message || error || "");
    return /instance is terminal|terminal orchestration|cannot accept new messages/i.test(message);
}

function appendSyntheticChatMessage(history, message) {
    return {
        ...(history || {}),
        chat: [
            ...((history && Array.isArray(history.chat)) ? history.chat : []),
            message,
        ],
    };
}

function formatTerminalReferenceLine(label, value) {
    return `- ${label}: ${value}`;
}

function buildTerminalSendRejectedMessage(session, error) {
    const shortSessionId = String(session?.sessionId || "unknown").slice(0, 8);
    const orchestrationStatus = String(session?.orchestrationStatus || "Unknown");
    const sessionStatus = String(session?.status || "unknown");
    const parentSessionId = session?.parentSessionId ? String(session.parentSessionId).slice(0, 8) : "root";
    const cronSummary = session?.cronActive === true || typeof session?.cronInterval === "number"
        ? session?.cronKind === "wall-clock"
            ? `active wall-clock${typeof session?.cronNextFireAt === "number" ? ` (next ${new Date(session.cronNextFireAt).toISOString()})` : ""}`
            : `active${typeof session?.cronInterval === "number" ? ` (${session.cronInterval}s)` : ""}`
        : "inactive";
    const body = [
        `Cannot send a new message because session ${shortSessionId} is attached to a terminal orchestration instance.`,
        "",
        "Reference:",
        formatTerminalReferenceLine("Session status", sessionStatus),
        formatTerminalReferenceLine("Orchestration status", orchestrationStatus),
        formatTerminalReferenceLine("Parent session", parentSessionId),
        formatTerminalReferenceLine("Cron", cronSummary),
    ];

    if (typeof session?.waitReason === "string" && session.waitReason.trim()) {
        body.push(formatTerminalReferenceLine("Wait reason", session.waitReason.trim()));
    }
    if (typeof session?.error === "string" && session.error.trim()) {
        body.push(formatTerminalReferenceLine("Error", session.error.trim().split("\n")[0]));
    } else if (error?.message) {
        body.push(formatTerminalReferenceLine("Reject reason", String(error.message).trim()));
    }
    if (typeof session?.result === "string" && session.result.trim()) {
        body.push(formatTerminalReferenceLine("Result", "completed response available"));
    }

    body.push("", "Create a new session to continue.");

    return {
        id: `send-error:${session?.sessionId || "unknown"}:${Date.now()}`,
        role: "system",
        text: body.join("\n"),
        time: "",
        createdAt: Date.now(),
        cardTitle: "Error",
        cardTitleColor: "red",
        cardBorderColor: "red",
    };
}

function shortSessionIdValue(sessionId) {
    return String(sessionId || "").slice(0, 8);
}

function ownerKeyForPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    return provider && subject ? `${provider}\u0001${subject}` : null;
}

function ownerDisplayName(owner, fallback = "unknown user") {
    return String(owner?.displayName || owner?.email || "").trim() || fallback;
}

// Owner key of the first-class System user. System-agent children inherit this
// owner; they belong to the static "System" filter entry, so we never mint a
// second, duplicate "System" owner bucket for them. Computed via the join
// helper so it stays byte-identical to real owner keys.
const SYSTEM_OWNER_KEY = ownerKeyForPrincipal({ provider: "system", subject: "system" });

function buildSessionOwnerFilterItems(state) {
    const principal = state.auth?.principal || null;
    const principalKey = ownerKeyForPrincipal(principal);
    const items = [
        {
            id: "all",
            kind: "all",
            label: "All",
            description: "Show every session, including system and unowned sessions.",
        },
        {
            id: "system",
            kind: "system",
            label: "System",
            description: "Show sessions created by system agents.",
        },
        {
            id: "unowned",
            kind: "unowned",
            label: "Unowned",
            description: "Show non-system sessions that do not have an owner link.",
        },
    ];

    if (principalKey) {
        const label = ownerDisplayName(principal, "current user");
        items.push({
            id: "me",
            kind: "me",
            label: `Me (${label})`,
            ownerKey: principalKey,
            description: "Show sessions owned by the authenticated user currently signed in.",
        });
        items.push({
            id: "shared",
            kind: "shared",
            label: "Shared with me",
            description: "Show sessions other users have shared with you.",
        });
    }

    const ownersByKey = new Map();
    for (const session of Object.values(state.sessions?.byId || {})) {
        const owner = session?.owner;
        const key = ownerKeyForPrincipal(owner);
        // Skip the current user (covered by "Me") and the System user (covered
        // by the static "System" entry — never a duplicate owner bucket).
        if (!key || key === principalKey || key === SYSTEM_OWNER_KEY || ownersByKey.has(key)) continue;
        ownersByKey.set(key, owner);
    }

    for (const [ownerKey, owner] of [...ownersByKey.entries()].sort((a, b) => (
        ownerDisplayName(a[1]).localeCompare(ownerDisplayName(b[1]))
    ))) {
        const label = ownerDisplayName(owner);
        const email = String(owner?.email || "").trim();
        items.push({
            id: `owner:${ownerKey}`,
            kind: "owner",
            ownerKey,
            label: email && email !== label ? `${label} <${email}>` : label,
            description: "Show sessions owned by this user.",
        });
    }

    return items;
}

export function defaultOwnerFilterForPrincipal(principal) {
    return ownerKeyForPrincipal(principal)
        ? {
            all: false,
            includeSystem: true,
            includeUnowned: false,
            includeMe: true,
            includeShared: true,
            ownerKeys: [],
        }
        : {
            all: true,
            includeSystem: false,
            includeUnowned: false,
            includeMe: false,
            includeShared: false,
            ownerKeys: [],
        };
}

function ownerFilterHasSelections(filter) {
    return Boolean(
        filter?.includeSystem
        || filter?.includeUnowned
        || filter?.includeMe
        || filter?.includeShared
        || (Array.isArray(filter?.ownerKeys) && filter.ownerKeys.length > 0),
    );
}

function toggleOwnerFilterItem(currentFilter, item, principal) {
    const current = currentFilter || defaultOwnerFilterForPrincipal(principal);
    if (!item) return current;
    if (item.kind === "all") {
        return current.all ? defaultOwnerFilterForPrincipal(principal) : {
            all: true,
            includeSystem: false,
            includeUnowned: false,
            includeMe: false,
            includeShared: false,
            ownerKeys: [],
        };
    }

    const next = {
        ...current,
        all: false,
        ownerKeys: Array.isArray(current.ownerKeys) ? [...current.ownerKeys] : [],
    };
    if (item.kind === "system") next.includeSystem = !next.includeSystem;
    if (item.kind === "unowned") next.includeUnowned = !next.includeUnowned;
    if (item.kind === "me") next.includeMe = !next.includeMe;
    if (item.kind === "shared") next.includeShared = !next.includeShared;
    if (item.kind === "owner" && item.ownerKey) {
        const existingIndex = next.ownerKeys.indexOf(item.ownerKey);
        if (existingIndex >= 0) {
            next.ownerKeys.splice(existingIndex, 1);
        } else {
            next.ownerKeys.push(item.ownerKey);
        }
    }

    return ownerFilterHasSelections(next)
        ? next
        : { all: true, includeSystem: false, includeUnowned: false, includeMe: false, includeShared: false, ownerKeys: [] };
}

function getRenameSessionPrefix(session) {
    if (!session?.agentId || session?.isSystem) return null;
    const currentTitle = String(session?.title || "").trim();
    if (!currentTitle) return null;
    const separatorIndex = currentTitle.indexOf(": ");
    if (separatorIndex > 0) {
        return currentTitle.slice(0, separatorIndex).trim() || null;
    }
    return null;
}

function getRenameSessionMaxLength(session) {
    const prefix = getRenameSessionPrefix(session);
    if (!prefix) return 60;
    return Math.max(1, 60 - `${prefix}: `.length);
}

function getRenameSessionEditableTitle(session) {
    const currentTitle = String(session?.title || "").trim();
    if (!currentTitle) return "";

    const prefix = getRenameSessionPrefix(session);
    if (prefix && currentTitle.startsWith(`${prefix}: `)) {
        const suffix = currentTitle.slice(`${prefix}: `.length).trim();
        if (!suffix || suffix === shortSessionIdValue(session?.sessionId)) return "";
        return suffix;
    }

    if (currentTitle === shortSessionIdValue(session?.sessionId)) return "";
    return currentTitle;
}

function formatAgentDisplayTitle(agentName, title) {
    const normalizedTitle = String(title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    const normalizedName = String(agentName || "").trim();
    return normalizedName
        ? normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1)
        : "Agent";
}

// ─── Agent picker: sections and composition ─────────────────────────────
//
// The picker used to be one flat list with `── Shared ──` / `── My agents ──`
// rules through it. That reads fine at six agents and not at all at forty:
// a deployment's own roster and four installed packages arrive as one
// undifferentiated column, and nothing says which agents belong together.
//
// So: two sections. BUILT-IN is every agent baked into the deployment (base
// PilotSwarm plus whatever the layered app ships), INSTALLED is one collapsed
// subsection per agent package. Inside a section, an agent that declares
// `startedBy` nests under the agent that starts it — a package's shape is
// visible before you start a session with it.

export const AGENT_PICKER_BUILTIN_KEY = "builtin";
// Installed packages split by ownership rather than sitting under one heading.
// "shared with the deployment" and "mine, private" are different trust stories
// — a shared package's agents run with the fleet's identity — and a user with
// only one kind should never be asked to read past a heading for the other.
export const AGENT_PICKER_SHARED_KEY = "installed:shared";
export const AGENT_PICKER_MINE_KEY = "installed:mine";

export function agentPickerPackageKey(agent) {
    const scope = String(agent?.packageScope || agent?.scope || "shared");
    const owner = String(agent?.ownerLabel || "");
    return `pkg:${scope}:${owner}:${String(agent?.packageName || "")}`;
}

// Same normalization the agent RESOLVER uses (see normalizeAgentName in
// agent-package-format): the runtime matches names case- and
// punctuation-insensitively, so "Editor_In_Chief" and "editor-in-chief" are
// one agent. Matching on the raw string here would nest by a stricter rule
// than the thing it is describing.
function normalizeAgentKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Order a set of agents as a forest: entry points first, each immediately
 * followed by the agents it creates.
 *
 * An entry point is an agent no OTHER agent in the same set creates. That is
 * the whole definition — there is no `main` field to declare and keep honest,
 * and a package with one, several or zero entry points all render correctly
 * from the same rule.
 *
 * `startedBy` names that do not resolve inside the set are ignored rather than
 * treated as errors: a package may legitimately be called by a deployment
 * agent, and an agent must never vanish from the picker because of a typo.
 */
function orderAgentsByComposition(agents) {
    const byName = new Map();
    for (const agent of agents) {
        if (agent?.agentName) byName.set(normalizeAgentKey(agent.agentName), agent);
    }

    const childrenOf = new Map();
    const parentOf = new Map();
    for (const agent of agents) {
        const self = normalizeAgentKey(agent.agentName);
        const parents = (agent.startedBy || [])
            .map((name) => normalizeAgentKey(name))
            .filter((name) => name && byName.has(name) && name !== self);
        if (parents.length === 0) continue;
        // First resolvable creator wins the nesting slot. An agent started by
        // two entry points is real; showing it twice would double-count the
        // section and make Enter ambiguous.
        const parent = parents[0];
        parentOf.set(agent, parent);
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(agent);
    }

    // Whether a name in `startedBy` resolved to an agent in THIS set is the
    // signal, not whether the field was present. A package that names a
    // creator in another package — or misspells one — has an agent that
    // nothing here starts, and it must stay an entry point rather than
    // becoming permanently unstartable in a section that still claims it as
    // one. (This is where the default for `supportsDirectStart` is applied;
    // an explicit value always wins.)
    const isNested = (agent) => parentOf.has(agent);
    const startable = (agent) => (
        typeof agent.supportsDirectStart === "boolean"
            ? agent.supportsDirectStart
            : !isNested(agent)
    );

    const ordered = [];
    const emitted = new Set();
    const emit = (agent, depth, parentName) => {
        // Also the cycle guard: a → b → a stops here rather than recursing.
        if (emitted.has(agent)) return;
        emitted.add(agent);
        ordered.push({
            ...agent,
            depth,
            parentAgentName: parentName || null,
            supportsDirectStart: startable(agent),
        });
        for (const child of childrenOf.get(normalizeAgentKey(agent.agentName)) || []) {
            emit(child, depth + 1, agent.agentName);
        }
    };

    for (const agent of agents) {
        if (isNested(agent)) continue;
        emit(agent, 0, null);
    }
    // Whatever is left is inside a cycle. Promote the CYCLE MEMBERS — the ones
    // whose parent chain returns to themselves — and let the recursion carry
    // their descendants down at the right depth. Promoting in array order
    // instead would surface an ordinary sub-agent as an entry point purely
    // because it happened to be listed before the cycle it hangs off.
    const inCycle = (agent) => {
        const seen = new Set();
        let current = agent;
        while (current && !seen.has(current)) {
            seen.add(current);
            current = byName.get(parentOf.get(current));
            if (current === agent) return true;
        }
        return false;
    };
    for (const agent of agents) {
        if (!emitted.has(agent) && inCycle(agent)) emit(agent, 0, null);
    }
    // Belt and braces: nothing may be dropped, whatever shape the graph is in.
    for (const agent of agents) emit(agent, 0, null);
    return ordered;
}

/**
 * Flatten the catalog into the VISIBLE row list the picker navigates.
 *
 * Section headings are items, not decoration: arrow keys walk onto them and
 * Enter toggles them, so the whole dialog is reachable without a mouse. Rows
 * inside a collapsed section are simply absent, which is what keeps
 * `selectedIndex` a plain index into this array.
 */
/** Where the cursor starts. See the call site for why it is not just 0. */
export function agentPickerInitialIndex(items = []) {
    const firstAgent = items.findIndex((item) => item.kind !== "section");
    if (firstAgent >= 0) return firstAgent;
    const firstClosed = items.findIndex((item) => item.kind === "section" && item.collapsed);
    return firstClosed >= 0 ? firstClosed : 0;
}

export function buildAgentPickerItems(catalog = [], collapsedKeys = [], genericItem = null) {
    const collapsed = new Set(collapsedKeys);
    const items = [];

    const builtins = catalog.filter((agent) => agent.builtin);
    const packaged = catalog.filter((agent) => !agent.builtin);

    // Generic sits ABOVE everything, outside both sections and outside every
    // collapse. It is not an agent — it is the absence of one — and it is the
    // most common pick, so it must never be a click away behind a twisty.
    if (genericItem) items.push({ ...genericItem, depth: 0 });

    if (builtins.length > 0) {
        const builtinAgents = orderAgentsByComposition(builtins);
        items.push({
            id: `section:${AGENT_PICKER_BUILTIN_KEY}`,
            kind: "section",
            sectionKind: "builtin",
            sectionKey: AGENT_PICKER_BUILTIN_KEY,
            title: "Built-in",
            meta: `${builtinAgents.length} agent${builtinAgents.length === 1 ? "" : "s"}`,
            collapsed: collapsed.has(AGENT_PICKER_BUILTIN_KEY),
            depth: 0,
        });
        if (!collapsed.has(AGENT_PICKER_BUILTIN_KEY)) {
            // One level in from the header, so the section reads as a
            // container rather than as a label floating above a flat list.
            items.push(...builtinAgents.map((agent) => ({ ...agent, depth: agent.depth + 1 })));
        }
    }

    // An empty category is omitted entirely rather than shown reading "0
    // packages" — a heading whose only content is its own emptiness is noise.
    for (const [sectionKey, title, belongs] of [
        [AGENT_PICKER_SHARED_KEY, "Installed · Shared", (agent) => agent.group !== "mine"],
        [AGENT_PICKER_MINE_KEY, "Installed · Yours", (agent) => agent.group === "mine"],
    ]) {
        const members = packaged.filter(belongs);
        if (members.length === 0) continue;

        const groups = new Map();
        for (const agent of members) {
            const key = agentPickerPackageKey(agent);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(agent);
        }
        items.push({
            id: `section:${sectionKey}`,
            kind: "section",
            sectionKind: "installed",
            sectionKey,
            title,
            meta: `${groups.size} package${groups.size === 1 ? "" : "s"}`,
            collapsed: collapsed.has(sectionKey),
            depth: 0,
        });
        if (collapsed.has(sectionKey)) continue;

        const keys = [...groups.keys()].sort((a, b) => {
            const at = groups.get(a)[0];
            const bt = groups.get(b)[0];
            return String(at.packageTitle || at.packageName || "")
                .localeCompare(String(bt.packageTitle || bt.packageName || ""));
        });
        for (const key of keys) {
            const packageAgents = orderAgentsByComposition(groups.get(key));
            const first = packageAgents[0] || {};
            const entries = packageAgents.filter((agent) => agent.depth === 0).length;
            items.push({
                id: `section:${key}`,
                kind: "section",
                sectionKind: "package",
                sectionKey: key,
                title: first.packageTitle || first.packageName || "Package",
                packageName: first.packageName || null,
                packageSemver: first.packageSemver || null,
                packageScope: first.packageScope || null,
                ownerLabel: first.ownerLabel || null,
                mine: first.group === "mine",
                // No scope badge: the section it sits in already says which
                // shelf this is, and repeating "[shared]" on every row under
                // "Installed · Shared" is the kind of noise that makes a list
                // harder to scan, not easier.
                meta: `${entries} ${entries === 1 ? "entry" : "entries"} · ${packageAgents.length} agent${packageAgents.length === 1 ? "" : "s"}`,
                collapsed: collapsed.has(key),
                depth: 1,
            });
            if (collapsed.has(key)) continue;
            // Package rows sit one level in from their section header, so
            // their sub-agents start at depth 2.
            items.push(...packageAgents.map((agent) => ({ ...agent, depth: agent.depth + 2 })));
        }
    }

    return items;
}

function buildPromptAttachmentToken(filename) {
    return `📎 ${String(filename || "").trim()}`;
}

function extractPromptReferenceContext(prompt, cursorIndex) {
    const text = String(prompt || "");
    const safeCursor = clampPromptCursor(text, cursorIndex, text.length);
    const left = text.slice(0, safeCursor);
    const match = left.match(/(^|\s)(@@?)([^\s]*)$/u);
    if (!match) return null;

    const trigger = match[2];
    const query = String(match[3] || "");
    return {
        kind: trigger === "@@" ? "sessions" : "artifacts",
        query,
        signature: `${trigger}${query}`,
        tokenStart: (match.index || 0) + String(match[1] || "").length,
        tokenEnd: safeCursor,
    };
}

function replacePromptTextRange(prompt, start, end, replacement) {
    const safePrompt = String(prompt || "");
    const rangeStart = clampPromptCursor(safePrompt, start, 0);
    const rangeEnd = clampPromptCursor(safePrompt, end, rangeStart);
    const nextText = String(replacement || "");
    return {
        prompt: `${safePrompt.slice(0, rangeStart)}${nextText}${safePrompt.slice(rangeEnd)}`,
        cursor: rangeStart + nextText.length,
    };
}

function normalizePromptReferenceLabel(value, fallback = "session") {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    return text || fallback;
}

function buildPromptSessionReferenceText(session) {
    const sessionId = String(session?.sessionId || "").trim();
    const fallbackLabel = shortSessionIdValue(sessionId) || "session";
    const label = normalizePromptReferenceLabel(session?.title, fallbackLabel);
    return `Referenced session: ${label} — session://${sessionId}`;
}

function replacePromptReferenceContext(prompt, context, replacement) {
    if (!context) {
        return insertPromptTextAtCursor(prompt, String(prompt || "").length, replacement);
    }
    const safePrompt = String(prompt || "");
    const nextChar = safePrompt.slice(context.tokenEnd, context.tokenEnd + 1);
    const needsTrailingSpace = !nextChar || /\s/u.test(nextChar);
    return replacePromptTextRange(
        safePrompt,
        context.tokenStart,
        context.tokenEnd,
        `${String(replacement || "")}${needsTrailingSpace ? " " : ""}`,
    );
}

function stripPromptAttachmentTokens(prompt, attachments = []) {
    let cleaned = String(prompt || "");
    for (const attachment of attachments || []) {
        const token = String(attachment?.token || "").trim();
        if (!token) continue;
        cleaned = cleaned.split(token).join(" ");
    }
    return cleaned
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

// Raster types + caps for image prompt attachments. Mirrors the SDK's
// IMAGE_ATTACHMENT_CONTENT_TYPES / ATTACHMENT_MAX_BYTES — the server is the
// enforcement point; these exist so the composer rejects early with a clear
// message instead of a failed send.
export const IMAGE_PROMPT_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const IMAGE_PROMPT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_PROMPT_ATTACHMENT_MAX_COUNT = 4;

function expandPromptAttachments(prompt, attachments = []) {
    const validAttachments = Array.isArray(attachments)
        // Image attachments are model-visible (sent as blob attachments by the
        // worker) — they inject NO text ref. Only legacy artifact references
        // still expand into artifact:// pointers.
        ? attachments.filter((attachment) => attachment?.sessionId && attachment?.filename && attachment?.kind !== "image")
        : [];
    if (validAttachments.length === 0) return String(prompt || "");

    const attachmentRefs = validAttachments.map((attachment) => (
        `[Attached file: ${attachment.filename} — artifact://${attachment.sessionId}/${attachment.filename}]`
    ));
    const cleanedPrompt = stripPromptAttachmentTokens(prompt, validAttachments);
    return attachmentRefs.join("\n") + (cleanedPrompt ? `\n\n${cleanedPrompt}` : "");
}

function clampRenameSessionValue(value, maxLength) {
    return String(value || "").replace(/\r?\n/g, " ").slice(0, Math.max(0, Number(maxLength) || 0));
}

function displayWidth(value) {
    return Array.from(String(value || "")).length;
}

function normalizeRenderableLines(lines) {
    const normalized = [];
    for (const line of lines || []) {
        if (line?.kind === "markup") {
            const parsed = parseTerminalMarkupRuns(line.value || "");
            for (const parsedLine of parsed) {
                normalized.push(parsedLine);
            }
            continue;
        }
        if (Array.isArray(line)) {
            normalized.push(line);
            continue;
        }
        normalized.push(line);
    }
    return normalized;
}

function countWrappedTextLines(text, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const renderedWidth = displayWidth(text);
    return Math.max(1, Math.ceil(renderedWidth / safeWidth));
}

function countWrappedRenderableLines(lines, width) {
    const safeWidth = Math.max(1, Number(width) || 1);
    return normalizeRenderableLines(lines).reduce((sum, line) => {
        if (!line) return sum + 1;
        if (Array.isArray(line)) {
            const lineWidth = line.reduce((acc, run) => acc + displayWidth(run?.text || ""), 0);
            return sum + Math.max(1, Math.ceil(lineWidth / safeWidth));
        }
        return sum + countWrappedTextLines(line.text || "", safeWidth);
    }, 0);
}

function clampPromptCursor(prompt, cursor) {
    const text = String(prompt || "");
    return Math.max(0, Math.min(Number(cursor) || 0, text.length));
}

function splitPromptLines(prompt) {
    return String(prompt || "").split("\n");
}

function getPromptCursorPosition(prompt, cursor) {
    const prefix = String(prompt || "").slice(0, clampPromptCursor(prompt, cursor));
    const lines = prefix.split("\n");
    const currentLine = lines[lines.length - 1] || "";
    return {
        line: Math.max(0, lines.length - 1),
        column: currentLine.length,
    };
}

function getPromptCursorIndex(prompt, line, column) {
    const lines = splitPromptLines(prompt);
    const safeLine = Math.max(0, Math.min(Number(line) || 0, Math.max(0, lines.length - 1)));
    const safeColumn = Math.max(0, Math.min(Number(column) || 0, lines[safeLine]?.length || 0));
    let index = 0;
    for (let currentLine = 0; currentLine < safeLine; currentLine += 1) {
        index += (lines[currentLine]?.length || 0) + 1;
    }
    return clampPromptCursor(prompt, index + safeColumn);
}

function insertPromptTextAtCursor(prompt, cursor, text) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    const insertion = String(text || "");
    return {
        prompt: `${safePrompt.slice(0, safeCursor)}${insertion}${safePrompt.slice(safeCursor)}`,
        cursor: safeCursor + insertion.length,
    };
}

function deletePromptCharBackward(prompt, cursor) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    if (safeCursor <= 0) {
        return { prompt: safePrompt, cursor: safeCursor };
    }
    return {
        prompt: `${safePrompt.slice(0, safeCursor - 1)}${safePrompt.slice(safeCursor)}`,
        cursor: safeCursor - 1,
    };
}

function isWordBoundaryWhitespace(value) {
    return /\s/u.test(value || "");
}

function movePromptCursorByWord(prompt, cursor, direction) {
    const safePrompt = String(prompt || "");
    let index = clampPromptCursor(safePrompt, cursor);
    if (direction < 0) {
        while (index > 0 && isWordBoundaryWhitespace(safePrompt[index - 1])) index -= 1;
        while (index > 0 && !isWordBoundaryWhitespace(safePrompt[index - 1])) index -= 1;
        return index;
    }
    while (index < safePrompt.length && isWordBoundaryWhitespace(safePrompt[index])) index += 1;
    while (index < safePrompt.length && !isWordBoundaryWhitespace(safePrompt[index])) index += 1;
    return index;
}

function deletePromptWordBackward(prompt, cursor) {
    const safePrompt = String(prompt || "");
    const safeCursor = clampPromptCursor(safePrompt, cursor);
    const nextCursor = movePromptCursorByWord(safePrompt, safeCursor, -1);
    if (nextCursor === safeCursor) {
        return { prompt: safePrompt, cursor: safeCursor };
    }
    return {
        prompt: `${safePrompt.slice(0, nextCursor)}${safePrompt.slice(safeCursor)}`,
        cursor: nextCursor,
    };
}

function movePromptCursorVertically(prompt, cursor, direction) {
    const lines = splitPromptLines(prompt);
    if (lines.length <= 1) return clampPromptCursor(prompt, cursor);
    const position = getPromptCursorPosition(prompt, cursor);
    const targetLine = Math.max(0, Math.min(position.line + direction, lines.length - 1));
    if (targetLine === position.line) return clampPromptCursor(prompt, cursor);
    return getPromptCursorIndex(prompt, targetLine, position.column);
}

// Automatic scroll-up expansion stops here; past it the user must ask for more
// explicitly. Exported so a surface can SHOW that control — the portal had no
// way to trigger EXPAND_HISTORY at all, so on a busy session (tens of thousands
// of events) scrolling up simply died with a status line telling the user to
// press a key that only exists in the TUI.
export const AUTO_HISTORY_EVENT_SOFT_CAP = 3_000;
const INSPECTOR_BOTTOM_ANCHORED_TABS = new Set(["logs", "sequence"]);
const FILE_PREVIEW_CHAR_LIMIT = 200_000;
const MARKDOWN_FILE_EXTENSIONS = new Set([
    ".md",
    ".markdown",
    ".mdown",
    ".mkd",
    ".mdx",
]);
const JSON_FILE_EXTENSIONS = new Set([
    ".json",
    ".jsonl",
]);
const BINARY_PREVIEW_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tgz",
    ".tar",
    ".wasm",
    ".sqlite",
    ".db",
]);

function fileExtension(filename) {
    const value = String(filename || "");
    const lastDot = value.lastIndexOf(".");
    return lastDot >= 0 ? value.slice(lastDot).toLowerCase() : "";
}

function isBinaryPreview(filename, contentType = "") {
    const ext = fileExtension(filename);
    const normalizedType = String(contentType || "").toLowerCase();
    if (BINARY_PREVIEW_EXTENSIONS.has(ext)) return true;
    return normalizedType.startsWith("image/")
        || normalizedType === "application/pdf"
        || normalizedType.startsWith("application/zip")
        || normalizedType === "application/wasm";
}

// How recent a `session.artifact_presented` event must be for the portal to
// act on it. Long enough to survive a slow turn and a brief reconnect; short
// enough that a catch-up burst after a long disconnect does not reorganize the
// workspace around something the agent said ages ago.
const PRESENTED_ARTIFACT_FRESHNESS_MS = 120_000;

function truncateFilePreview(content, limit = FILE_PREVIEW_CHAR_LIMIT) {
    const text = String(content ?? "");
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[Preview truncated at ${limit.toLocaleString()} characters. Open the artifact directly if you need the full file.]`;
}

function formatPreviewBytes(value) {
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

function buildBinaryPreviewNote(filename, contentType = "", sizeBytes = null) {
    const lines = [
        `Preview is not available here for ${filename}.`,
        "",
    ];
    if (contentType) {
        lines.push(`Type: ${contentType}`);
    }
    if (sizeBytes != null) {
        lines.push(`Size: ${formatPreviewBytes(sizeBytes)}`);
    }
    lines.push("Download the artifact to open it in the default app.");
    return lines.join("\n");
}

function normalizePreviewPayload(filename, rawContent, contentType = "", metadata = null) {
    const normalizedType = String(contentType || "").toLowerCase();
    const ext = fileExtension(filename);

    if (metadata?.isBinary === true || isBinaryPreview(filename, contentType)) {
        return {
            content: buildBinaryPreviewNote(filename, metadata?.contentType || contentType, metadata?.sizeBytes ?? null),
            contentType: metadata?.contentType || contentType || "application/octet-stream",
            renderMode: "note",
            isBinary: true,
            sizeBytes: metadata?.sizeBytes ?? null,
            uploadedAt: metadata?.uploadedAt || "",
            source: metadata?.source || "agent",
        };
    }

    const truncatedText = truncateFilePreview(rawContent);
    if (MARKDOWN_FILE_EXTENSIONS.has(ext) || normalizedType.includes("markdown")) {
        return {
            content: truncatedText,
            contentType: contentType || "text/markdown",
            renderMode: "markdown",
            isBinary: false,
            sizeBytes: metadata?.sizeBytes ?? null,
            uploadedAt: metadata?.uploadedAt || "",
            source: metadata?.source || "agent",
        };
    }

    if (JSON_FILE_EXTENSIONS.has(ext) || normalizedType.includes("json")) {
        try {
            return {
                content: truncateFilePreview(JSON.stringify(JSON.parse(String(rawContent ?? "")), null, 2)),
                contentType: contentType || "application/json",
                renderMode: "text",
            };
        } catch {
            return {
                content: truncatedText,
                contentType: contentType || "application/json",
                renderMode: "text",
            };
        }
    }

    return {
        content: truncatedText,
        contentType: contentType || "text/plain",
        renderMode: "text",
    };
}

/** How long a fetched artifact list is trusted before a refetch. */
const FILES_LIST_TTL_MS = 10_000;
// How long keyboard navigation must rest on a session before it is fetched.
// Long enough that scrolling past a row costs nothing, short enough that
// landing on one feels immediate.
const SESSION_NAV_SETTLE_MS = 140;
// Ceiling on the window a session re-opens with, in events (5 history pages).
//
// `loadedEventLimit` is sticky: scrolling back through a long session escalates
// it 300 -> 1000 -> 3000 -> 10000, and ensureSessionHistory then re-requested
// that expanded size on EVERY switch-in, for the life of the tab. So one trip
// through the history of a busy session made it permanently expensive to open —
// 10k events re-fetched, re-derived and re-laid-out each time. Paging back
// still expands freely while you are in the session; re-entering starts bounded.
const HISTORY_REENTRY_MAX_EVENTS = 1_500;

// ── Provider budgets ────────────────────────────────────────────────
//
// The model: docs/proposals/providers-and-budgets.md. A provider is a name
// with a credential and a budget; a session runs `provider:model` and that
// provider is charged. There are no pools, no payers and no access lists —
// what a person may spend is decided by QUANTITY (limits, and an allowance
// that divides each limit), never by identity.
//
// The surface reads this out of `state.budget` through
// `selectProviderTable`. The one helper here is for the model PICKER, which
// cannot: it reads the namespace fresh when it opens, because a provider
// created a minute ago has to be offerable without a page load.

const PICKER_PERIOD_TITLE = { day: "Daily", week: "Weekly", month: "Monthly" };

/**
 * The message the server wrote, unchanged.
 *
 * A provider refusal is written for the person who hit it and names the
 * remedy — "the cluster default must be a shared provider", "there is no
 * provider named carol-ghcp". Replacing it with a generic sentence throws
 * away the only part of the answer anyone can act on. Only a failure with
 * nothing to say at all gets a fallback.
 */
function budgetRefusalMessage(error) {
    const message = typeof error?.message === "string" ? error.message.trim() : "";
    if (message) return message;
    const raw = String(error ?? "").trim();
    return raw || "The request failed.";
}

/**
 * What the model picker prints beside a provider, so the choice is made
 * knowing. The state names are the ones `selectProviderTable` uses, so a
 * component can style both from one set of classes.
 *
 * A provider with no STATUS row gets "unknown", never a confident "no
 * limits": one is a claim about the budget and the other is an admission
 * that it was not read, and only one of them is safe to act on.
 */
function providerPickerNote(provider, statusRow, now = Date.now()) {
    if (provider?.hasCredential === false) {
        return { state: "no_credential", text: "no credential — nothing can run on it" };
    }
    const held = provider?.holdIndefinite === true
        || (provider?.holdUntilUtc ? Date.parse(provider.holdUntilUtc) > now : false);
    if (held) {
        return { state: "hold", text: "on hold — new turns wait until it is released" };
    }
    if (!statusRow) return { state: "unknown", text: "budget unknown" };
    const rules = Array.isArray(statusRow.rules) ? statusRow.rules : [];
    if (rules.length === 0) return { state: "no_limits", text: "no limit" };
    // The binding one: what is already stopping turns, else what is nearest
    // to stopping them. Ranking by percentage alone put a comfortable weekly
    // limit above a daily one that was already full.
    const scored = rules.map((rule) => {
        const limitTokens = Number(rule?.limitTokens) || 0;
        const usedTokens = Number(rule?.usedTokens) || 0;
        const ceilingTokens = rule?.ceilingTokens == null ? null : Number(rule.ceilingTokens);
        const yourUsedTokens = Number(rule?.yourUsedTokens) || 0;
        return {
            periodLabel: PICKER_PERIOD_TITLE[rule?.period] || String(rule?.period || ""),
            pct: limitTokens > 0 ? Math.floor((usedTokens / limitTokens) * 100) : 0,
            atLimit: limitTokens > 0 && usedTokens >= limitTokens,
            atCeiling: ceilingTokens != null && ceilingTokens > 0 && yourUsedTokens >= ceilingTokens,
        };
    });
    const worst = [...scored].sort((a, b) => (
        ((a.atLimit || a.atCeiling) ? 0 : 1) - ((b.atLimit || b.atCeiling) ? 0 : 1) || b.pct - a.pct
    ))[0];
    if (worst.atLimit) {
        return {
            state: "at_limit",
            text: `at its ${worst.periodLabel.toLowerCase()} limit — a session here waits for the reset`,
        };
    }
    // The provider still has room; this person does not. Different remedy,
    // so different words: raising the limit changes nothing here.
    if (worst.atCeiling) {
        return {
            state: "at_limit",
            text: `your share of its ${worst.periodLabel.toLowerCase()} limit is used up`,
        };
    }
    return { state: "under_limit", text: `${worst.pct}% of its ${worst.periodLabel.toLowerCase()} limit used` };
}

export class PilotSwarmUiController {
    constructor({ store, transport }) {
        this.store = store;
        this.transport = transport;
        this.catalogTimer = null;
        this.activeSessionUnsub = null;
        this.activeSessionSubscriptionId = null;
        this.activeSessionDetailTimer = null;
        this.activeSessionDetailSessionId = null;
        this.sessionRefreshTimer = null;
        this.sessionHistoryLoads = new Map();
        this.sessionHistoryExpansionLoads = new Map();
        this.sessionOrchestrationStatsLoads = new Map();
        this.outboxFlushPromises = new Map();
        this.logUnsubscribe = null;
        this.promptReferenceSignature = null;
        this.promptReferenceSyncVersion = 0;
        this.chatTopHistoryLoadArmed = false;
        this.chatTopHistoryLoadSessionId = null;
    }

    getState() {
        return this.store.getState();
    }

    subscribe(listener) {
        return this.store.subscribe(listener);
    }

    dispatch(action) {
        return this.store.dispatch(action);
    }

    setStatus(text) {
        this.dispatch({ type: "ui/status", text });
    }

    getPromptAttachments() {
        const attachments = this.getState().ui.promptAttachments;
        return Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    }

    setPromptAttachments(attachments) {
        this.dispatch({
            type: "ui/promptAttachments",
            attachments: Array.isArray(attachments) ? attachments : [],
        });
    }

    getSessionOutbox(sessionId) {
        if (!sessionId) return [];
        const items = this.getState().outbox?.bySessionId?.[sessionId];
        return Array.isArray(items) ? items.filter(Boolean) : [];
    }

    setSessionOutboxItems(sessionId, items) {
        if (!sessionId) return;
        this.dispatch({
            type: "outbox/setSessionItems",
            sessionId,
            items: Array.isArray(items) ? items : [],
        });
    }

    buildOutboxItem(prompt, phase = "pending") {
        const id = `msg:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
        const normalizedPhase = phase === "queued" || phase === "cancelling" ? phase : "pending";
        return {
            id,
            text: String(prompt || ""),
            createdAt: Date.now(),
            phase: normalizedPhase,
            attempted: false,
            clientMessageIds: [id],
        };
    }

    getPendingOutboxItems(sessionId) {
        return this.getSessionOutbox(sessionId).filter((item) => item?.phase === "pending");
    }

    getQueuedOutboxItems(sessionId) {
        return this.getSessionOutbox(sessionId).filter((item) => item?.phase === "queued");
    }

    getNavigableOutboxItems(sessionId) {
        return this.getSessionOutbox(sessionId).filter((item) => (
            item?.phase === "pending" || item?.phase === "queued" || item?.phase === "cancelling"
        ));
    }

    getEditableOutboxItems(sessionId) {
        // Attempted envelopes are immutable because the server may already
        // have accepted their IDs even when the client saw a transport error.
        return this.getPendingOutboxItems(sessionId).filter((item) => item?.attempted !== true);
    }

    getPromptEditSessionMatch(sessionId = this.getState().sessions.activeSessionId) {
        const promptEdit = this.getState().ui.promptEdit;
        return promptEdit?.sessionId === sessionId ? promptEdit : null;
    }

    enterPendingPromptEdit(sessionId, itemId) {
        if (!sessionId || !itemId) return false;
        const navigableItems = this.getNavigableOutboxItems(sessionId);
        const item = navigableItems.find((candidate) => candidate.id === itemId);
        if (!item) return false;

        const currentUi = this.getState().ui;
        const existingEdit = this.getPromptEditSessionMatch(sessionId);
        const promptEdit = existingEdit
            ? { ...existingEdit, itemId, phase: item.phase }
            : {
                sessionId,
                itemId,
                phase: item.phase,
                draftPrompt: currentUi.prompt,
                draftCursor: currentUi.promptCursor,
            };

        this.dispatch({ type: "ui/promptEdit", promptEdit });
        this.setPrompt(item.text, item.text.length);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        return true;
    }

    exitPendingPromptEdit({ restoreDraft = true } = {}) {
        const promptEdit = this.getState().ui.promptEdit;
        if (!promptEdit) return false;

        this.dispatch({ type: "ui/promptEdit", promptEdit: null });
        if (restoreDraft) {
            this.setPrompt(
                promptEdit.draftPrompt || "",
                Number.isFinite(promptEdit.draftCursor) ? promptEdit.draftCursor : String(promptEdit.draftPrompt || "").length,
            );
        }
        return true;
    }

    selectPreviousPendingPrompt(sessionId = this.getState().sessions.activeSessionId) {
        const navigableItems = this.getNavigableOutboxItems(sessionId);
        if (navigableItems.length === 0) return false;

        const promptEdit = this.getPromptEditSessionMatch(sessionId);
        if (!promptEdit) {
            return this.enterPendingPromptEdit(sessionId, navigableItems[navigableItems.length - 1].id);
        }

        const currentIndex = navigableItems.findIndex((item) => item.id === promptEdit.itemId);
        if (currentIndex <= 0) return false;
        return this.enterPendingPromptEdit(sessionId, navigableItems[currentIndex - 1].id);
    }

    selectNextPendingPrompt(sessionId = this.getState().sessions.activeSessionId) {
        const navigableItems = this.getNavigableOutboxItems(sessionId);
        const promptEdit = this.getPromptEditSessionMatch(sessionId);
        if (!promptEdit) return false;

        const currentIndex = navigableItems.findIndex((item) => item.id === promptEdit.itemId);
        if (currentIndex === -1 || currentIndex >= navigableItems.length - 1) {
            return this.exitPendingPromptEdit({ restoreDraft: true });
        }

        return this.enterPendingPromptEdit(sessionId, navigableItems[currentIndex + 1].id);
    }

    async cancelSelectedOutboxPrompt() {
        const promptEdit = this.getState().ui.promptEdit;
        if (!promptEdit?.sessionId || !promptEdit?.itemId) return false;

        const currentItems = this.getSessionOutbox(promptEdit.sessionId);
        const currentItem = currentItems.find((item) => item.id === promptEdit.itemId);
        if (!currentItem) return false;
        if (currentItem.phase === "cancelling") {
            this.exitPendingPromptEdit({ restoreDraft: true });
            return false;
        }

        const cancelled = await this.cancelOutboxItem(promptEdit.sessionId, promptEdit.itemId);
        if (!cancelled) return false;

        this.exitPendingPromptEdit({ restoreDraft: true });
        return true;
    }

    cancelSelectedPendingPrompt() {
        const promptEdit = this.getState().ui.promptEdit;
        if (!promptEdit?.sessionId || !promptEdit?.itemId) return false;

        const currentItems = this.getSessionOutbox(promptEdit.sessionId);
        const currentItem = currentItems.find((item) => item.id === promptEdit.itemId && item.phase === "pending");
        if (!currentItem) return false;

        const nextItems = currentItems.filter((item) => item.id !== promptEdit.itemId);
        this.setSessionOutboxItems(promptEdit.sessionId, nextItems);

        this.exitPendingPromptEdit({ restoreDraft: true });

        this.dispatch({ type: "ui/status", text: "Cancelled pending prompt" });
        return true;
    }

    /**
     * Cancel an outbox item by id. Pending (○) items are removed locally and
     * also send a best-effort durable cancel tombstone to cover the race where
     * the portal has already merged them into an enqueue. Queued (✓) items move
     * to cancelling (x) while the durable cancel tombstone is sent through the
     * transport so the orchestration can drop the message before the LLM sees
     * it. The row disappears only after runtime confirms.
     *
     * Idempotent: if the durable cancel races the orchestration consuming the
     * message, the tombstone is a no-op on the runtime side.
     */
    async cancelOutboxItem(sessionId, itemId) {
        if (!sessionId || !itemId) return false;
        const items = this.getSessionOutbox(sessionId);
        const item = items.find((candidate) => candidate.id === itemId);
        if (!item) return false;
        if (item.phase === "cancelling") return false;

        if (this.getPromptEditSessionMatch(sessionId)?.itemId === itemId) {
            this.exitPendingPromptEdit({ restoreDraft: true });
        }

        const ids = Array.isArray(item.clientMessageIds) && item.clientMessageIds.length > 0
            ? item.clientMessageIds
            : [item.id];

        if (item.phase === "queued") {
            this.setSessionOutboxItems(sessionId, items.map((candidate) => (
                candidate.id === itemId ? { ...candidate, phase: "cancelling" } : candidate
            )));
            if (typeof this.transport?.cancelPendingMessage === "function") {
                try {
                    await this.transport.cancelPendingMessage(sessionId, ids);
                    this.dispatch({ type: "ui/status", text: "Cancelling queued prompt" });
                } catch (error) {
                    // Restore the item so the user can retry the cancel.
                    this.setSessionOutboxItems(sessionId, items);
                    this.dispatch({ type: "ui/status", text: error?.message || String(error) });
                    return false;
                }
            } else {
                this.dispatch({ type: "ui/status", text: "Queued prompt marked cancelling (local only — transport has no cancel)" });
            }
        } else {
            const remainingItems = items.filter((candidate) => candidate.id !== itemId);
            this.setSessionOutboxItems(sessionId, remainingItems);
            if (typeof this.transport?.cancelPendingMessage === "function") {
                try {
                    await this.transport.cancelPendingMessage(sessionId, ids);
                } catch {
                    // Pending cancels are local-first. A failed tombstone only
                    // matters if the item was already being merged into a
                    // durable enqueue, and the user can still cancel the merged
                    // queued item if it appears.
                }
            }
            this.dispatch({ type: "ui/status", text: "Cancelled pending prompt" });
        }
        return true;
    }

    /**
     * Convenience: cancel the most recently queued (durable) outbox item.
     * Used by hosts to give the user a single-keystroke way to cancel the
     * latest queued prompt without first navigating to it.
     */
    async cancelLatestQueuedOutbox(sessionId = this.getState().sessions.activeSessionId) {
        if (!sessionId) return false;
        const queued = this.getQueuedOutboxItems(sessionId);
        if (queued.length === 0) return false;
        const target = queued[queued.length - 1];
        return await this.cancelOutboxItem(sessionId, target.id);
    }

    queuePromptInOutbox(sessionId, prompt, extras = null) {
        const item = this.buildOutboxItem(prompt, "pending");
        if (Array.isArray(extras?.attachments) && extras.attachments.length > 0) {
            item.attachments = extras.attachments;
        }
        this.setSessionOutboxItems(sessionId, [...this.getSessionOutbox(sessionId), item]);
        return item;
    }

    /**
     * Stage image files (paste / drop / picker) as pending prompt attachments.
     * Client-side pre-validation only — the API edge re-validates on send.
     * Returns { accepted, rejected: [{name, reason}] } for UI feedback.
     */
    addPendingImageFiles(files) {
        const incoming = Array.from(files || []).filter(Boolean);
        const current = this.getPromptAttachments();
        const existingImages = current.filter((a) => a?.kind === "image");
        const accepted = [];
        const rejected = [];
        for (const file of incoming) {
            const contentType = String(file.type || "").toLowerCase();
            if (!IMAGE_PROMPT_ATTACHMENT_TYPES.has(contentType)) {
                rejected.push({ name: file.name || "image", reason: "unsupported type" });
                continue;
            }
            if ((Number(file.size) || 0) > IMAGE_PROMPT_ATTACHMENT_MAX_BYTES) {
                rejected.push({ name: file.name || "image", reason: "over 4 MB" });
                continue;
            }
            if (existingImages.length + accepted.length >= IMAGE_PROMPT_ATTACHMENT_MAX_COUNT) {
                rejected.push({ name: file.name || "image", reason: `max ${IMAGE_PROMPT_ATTACHMENT_MAX_COUNT} images` });
                continue;
            }
            accepted.push({
                kind: "image",
                file,
                filename: String(file.name || "image"),
                contentType,
                sizeBytes: Number(file.size) || 0,
            });
        }
        if (accepted.length > 0) {
            this.setPromptAttachments([...current, ...accepted]);
        }
        if (rejected.length > 0) {
            this.dispatch({
                type: "ui/status",
                text: `Skipped ${rejected.map((r) => `${r.name} (${r.reason})`).join(", ")}`,
            });
        }
        return { accepted: accepted.length, rejected };
    }

    /**
     * Stage an already-uploaded raster artifact as a prompt image attachment
     * (uploaded:true entries skip re-upload at send). Returns whether staged.
     * Shared by the TUI upload modal and clipboard paste.
     */
    stageUploadedImageAttachment(result, sessionId) {
        const contentType = String(result?.contentType || "").toLowerCase();
        if (!IMAGE_PROMPT_ATTACHMENT_TYPES.has(contentType)) return false;
        if ((Number(result?.sizeBytes) || 0) > IMAGE_PROMPT_ATTACHMENT_MAX_BYTES) return false;
        const stagedImages = this.getPromptAttachments().filter((a) => a?.kind === "image");
        if (stagedImages.length >= IMAGE_PROMPT_ATTACHMENT_MAX_COUNT) return false;
        this.setPromptAttachments([
            ...this.getPromptAttachments(),
            {
                kind: "image",
                uploaded: true,
                sessionId,
                filename: result.filename,
                contentType,
                sizeBytes: Number(result?.sizeBytes) || 0,
            },
        ]);
        return true;
    }

    /**
     * TUI Ctrl+V: read an image off the OS clipboard (the transport shells to
     * the platform clipboard tool — terminals never deliver image bytes),
     * upload it as a session artifact, and stage it on the next message.
     */
    async pasteImageFromClipboard() {
        if (typeof this.transport.captureClipboardImage !== "function"
            || typeof this.transport.uploadArtifactFromPath !== "function") {
            this.dispatch({ type: "ui/status", text: "Clipboard image paste is not supported by this transport" });
            return false;
        }
        let capture = null;
        try {
            capture = await this.transport.captureClipboardImage();
        } catch (error) {
            this.dispatch({ type: "ui/status", text: `Clipboard read failed: ${error?.message || error}` });
            return false;
        }
        if (!capture?.path) {
            this.dispatch({ type: "ui/status", text: "No image on the clipboard" });
            return false;
        }
        this.dispatch({ type: "ui/status", text: "Attaching clipboard image..." });
        try {
            const sessionId = this.getPromptDraftSessionId() || await this.ensurePromptAttachmentSessionId();
            const upload = await this.transport.uploadArtifactFromPath(sessionId, capture.path);
            const result = await this.finalizeArtifactUpload(upload, { sessionId, suppressStatus: true });
            if (this.stageUploadedImageAttachment(result, sessionId)) {
                this.dispatch({ type: "ui/status", text: `Clipboard image attached to your next message (${result.filename})` });
                return true;
            }
            this.dispatch({ type: "ui/status", text: `Uploaded ${result.filename} (not attachable: type/size/count limit)` });
            return false;
        } catch (error) {
            this.dispatch({ type: "ui/status", text: `Clipboard image attach failed: ${error?.message || error}` });
            return false;
        }
    }

    removePendingImageAttachment(index) {
        const current = this.getPromptAttachments();
        const images = current.filter((a) => a?.kind === "image");
        const target = images[index];
        if (!target) return;
        this.setPromptAttachments(current.filter((a) => a !== target));
    }

    /**
     * Upload staged image attachments as session artifacts and return send
     * refs. Filenames are derived from the outbox client-message id so a
     * retry overwrites the same artifact instead of duplicating it.
     * Entries staged from an already-uploaded artifact (TUI attach-by-path,
     * marked uploaded:true with no File) skip the upload and ref directly.
     */
    async uploadPendingImageAttachments(sessionId, images, clientMessageId) {
        const refs = [];
        const idStem = String(clientMessageId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || "img";
        let uploadIndex = 0;
        for (const image of images) {
            if (!image.file) {
                if (image.uploaded && image.filename) refs.push({ filename: image.filename });
                continue;
            }
            uploadIndex += 1;
            const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.contentType] || "png";
            const filename = `attach-${idStem}-${uploadIndex}.${ext}`;
            await this.transport.uploadArtifactFromFile(sessionId, image.file, filename);
            refs.push({ filename });
        }
        return refs;
    }

    acknowledgeOutboxPrompt(sessionId, promptText, clientMessageId = null) {
        if (!sessionId) return false;
        const items = this.getSessionOutbox(sessionId);

        // Prefer exact id match if the durable event carried our clientMessageId.
        if (clientMessageId) {
            const idMatchIndex = items.findIndex((item) => (
                (item?.phase === "pending" || item?.phase === "queued" || item?.phase === "cancelling")
                && Array.isArray(item.clientMessageIds)
                && item.clientMessageIds.includes(clientMessageId)
            ));
            if (idMatchIndex !== -1) {
                const matchedItem = items[idMatchIndex];
                this.setSessionOutboxItems(sessionId, items.filter((_, i) => i !== idMatchIndex));
                if (this.getPromptEditSessionMatch(sessionId)?.itemId === matchedItem?.id) {
                    this.exitPendingPromptEdit({ restoreDraft: true });
                }
                return true;
            }
        }

        // Fall back to text match for backward compatibility while clientMessageId
        // hasn't been plumbed through every layer yet.
        const normalizedPrompt = normalizeOutboxPromptText(promptText);
        if (!normalizedPrompt) return false;
        const textMatchIndex = items.findIndex((item) => (
            (item?.phase === "pending" || item?.phase === "queued" || item?.phase === "cancelling")
            && normalizeOutboxPromptText(item.text) === normalizedPrompt
        ));
        if (textMatchIndex === -1) return false;

        const matchedItem = items[textMatchIndex];
        this.setSessionOutboxItems(sessionId, items.filter((_, i) => i !== textMatchIndex));
        if (this.getPromptEditSessionMatch(sessionId)?.itemId === matchedItem?.id) {
            this.exitPendingPromptEdit({ restoreDraft: true });
        }
        return true;
    }

    acknowledgeCancelledOutboxPrompt(sessionId, clientMessageIds = []) {
        if (!sessionId) return false;
        const ids = new Set((clientMessageIds || []).filter((id) => typeof id === "string" && id));
        if (ids.size === 0) return false;

        const items = this.getSessionOutbox(sessionId);
        const nextItems = items.filter((item) => {
            if (item?.phase !== "cancelling") return true;
            const itemIds = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [item.id];
            return !itemIds.some((id) => ids.has(id));
        });
        if (nextItems.length === items.length) return false;

        const removedIds = new Set(items
            .filter((item) => !nextItems.some((nextItem) => nextItem.id === item.id))
            .map((item) => item.id));
        this.setSessionOutboxItems(sessionId, nextItems);
        const promptEdit = this.getPromptEditSessionMatch(sessionId);
        if (promptEdit && removedIds.has(promptEdit.itemId)) {
            this.exitPendingPromptEdit({ restoreDraft: true });
        }
        return true;
    }

    scheduleOutboxDispatch(sessionId) {
        if (!sessionId) return;
        if (!this._outboxDispatchTimers) this._outboxDispatchTimers = new Map();
        if (this._outboxDispatchTimers.has(sessionId)) return;
        // Microtask + small delay so multiple synchronous sends coalesce into
        // one merged durable enqueue. The merge window is intentionally tiny
        // (~10ms) so the user never feels latency on a single send.
        const timer = setTimeout(() => {
            this._outboxDispatchTimers.delete(sessionId);
            this.dispatchPendingOutbox(sessionId).catch(() => {});
        }, 10);
        this._outboxDispatchTimers.set(sessionId, timer);
    }

    async dispatchPendingOutbox(sessionId) {
        if (!sessionId) return false;
        // Yield once so any other `sendPrompt()` calls firing in the same tick
        // get a chance to enqueue their pending items before we snapshot the
        // pending set. This is what gives "two concurrent sends merge into a
        // single durable enqueue" its semantics. Sequential `await sendPrompt`
        // calls are not affected — by the time the next one runs, the first
        // dispatch has already completed.
        await Promise.resolve();

        const existing = this.outboxFlushPromises.get(sessionId);
        if (existing) {
            // An enqueue is already in flight; the current pending items will
            // be picked up by the next dispatch after it resolves.
            await existing.catch(() => {});
            // Re-arm if more pending items have arrived since.
            if (this.getPendingOutboxItems(sessionId).length > 0) {
                this.scheduleOutboxDispatch(sessionId);
            }
            return false;
        }

        const allPendingItems = this.getPendingOutboxItems(sessionId);
        const attemptedItem = allPendingItems.find((item) => item?.attempted === true);
        const pendingItems = attemptedItem
            ? [attemptedItem]
            : allPendingItems.filter((item) => item?.attempted !== true);
        if (pendingItems.length === 0) return false;

        // Merge all current pending items into a single durable envelope.
        // Each contributing client message id is preserved on the merged item
        // so durable acknowledgement and (later) durable cancel can address
        // individual original messages even after merging.
        const mergedClientMessageIds = pendingItems.flatMap((item) => (
            Array.isArray(item.clientMessageIds) && item.clientMessageIds.length > 0
                ? item.clientMessageIds
                : [item.id]
        ));
        const mergedText = pendingItems.map((item) => String(item.text || "")).join("\n\n");
        const mergedAttachments = pendingItems.flatMap((item) => (
            Array.isArray(item.attachments) ? item.attachments : []
        ));
        const mergedItem = {
            id: pendingItems[0].id,
            text: mergedText,
            createdAt: pendingItems[0].createdAt || Date.now(),
            phase: "pending",
            attempted: true,
            clientMessageIds: mergedClientMessageIds,
            ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
        };
        const pendingIdSet = new Set(pendingItems.map((item) => item.id));
        const otherItems = this.getSessionOutbox(sessionId).filter((item) => !pendingIdSet.has(item.id));
        this.setSessionOutboxItems(sessionId, [...otherItems, mergedItem]);

        // If the user was editing one of the merged items, exit edit mode —
        // the merged item is now a single envelope.
        const promptEdit = this.getPromptEditSessionMatch(sessionId);
        if (promptEdit && pendingIdSet.has(promptEdit.itemId)) {
            this.exitPendingPromptEdit({ restoreDraft: true });
        }

        const promise = (async () => {
            await this.transport.sendMessage(sessionId, mergedItem.text, {
                enqueueOnly: true,
                clientMessageIds: mergedItem.clientMessageIds,
                ...(Array.isArray(mergedItem.attachments) && mergedItem.attachments.length > 0
                    ? { attachments: mergedItem.attachments }
                    : {}),
            });

            // Promote pending → queued for the merged item.
            const items = this.getSessionOutbox(sessionId);
            const updated = items.map((item) => (
                item.id === mergedItem.id ? { ...item, phase: "queued" } : item
            ));
            this.setSessionOutboxItems(sessionId, updated);

            this.syncSessionEvents(sessionId).catch(() => {});
            this.scheduleSessionsRefresh(250);
            return true;
        })().catch((error) => {
            const authRefused = error?.code === "FORBIDDEN" || error?.code === "UNAUTHORIZED"
                || error?.status === 403 || error?.status === 401;
            const items = this.getSessionOutbox(sessionId);
            if (authRefused) {
                // Authorization refusals are terminal — retrying can't succeed.
                // Mark the envelope rejected (renders as the red ✗, same as a
                // cancelled send) and drop it shortly after instead of leaving
                // a forever-pending item.
                const rejected = items.map((item) => (
                    item.id === mergedItem.id ? { ...item, phase: "rejected" } : item
                ));
                this.setSessionOutboxItems(sessionId, rejected);
                setTimeout(() => {
                    const current = this.getSessionOutbox(sessionId);
                    const remaining = current.filter((item) => !(item.id === mergedItem.id && item.phase === "rejected"));
                    if (remaining.length !== current.length) {
                        this.setSessionOutboxItems(sessionId, remaining);
                    }
                }, 6000);
            } else {
                // Transient failure: preserve the exact attempted envelope.
                // Re-merging it with fresh messages could make server-side
                // duplicate suppression drop the fresh content too.
                const reverted = items.map((item) => (
                    item.id === mergedItem.id ? { ...mergedItem, phase: "pending", attempted: true } : item
                ));
                this.setSessionOutboxItems(sessionId, reverted);
            }
            this.dispatch({
                type: "ui/status",
                text: error?.message || String(error),
            });
            throw error;
        }).finally(() => {
            this.outboxFlushPromises.delete(sessionId);
            // If new pending items arrived during the in-flight enqueue, dispatch them.
            if (this.getPendingOutboxItems(sessionId).length > 0) {
                this.scheduleOutboxDispatch(sessionId);
            }
        });

        this.outboxFlushPromises.set(sessionId, promise);
        return await promise;
    }

    // Backwards-compatible alias kept for any callers that still reference
    // the old flushQueuedOutbox name. The new model dispatches pending →
    // queued automatically; an explicit flush just forces the next dispatch.
    async flushQueuedOutbox(sessionId) {
        return await this.dispatchPendingOutbox(sessionId);
    }

    maybeFlushQueuedOutbox(sessionId) {
        if (!sessionId) return false;
        if (this.getPendingOutboxItems(sessionId).length === 0) return false;
        this.scheduleOutboxDispatch(sessionId);
        return true;
    }

    getPromptReferenceContext() {
        const state = this.getState();
        return extractPromptReferenceContext(state.ui.prompt, state.ui.promptCursor);
    }

    acceptPromptReferenceAutocomplete() {
        const context = this.getPromptReferenceContext();
        if (!context) return false;
        if (context.kind === "sessions") {
            return this.acceptSessionPromptReference(context);
        }
        return this.acceptArtifactPromptReference(context);
    }

    acceptArtifactPromptReference(context = this.getPromptReferenceContext()) {
        if (!context || context.kind !== "artifacts") return false;

        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        const sessionId = selectedItem?.sessionId || state.sessions.activeSessionId || null;
        const filename = selectedItem?.filename || null;
        if (!sessionId || !filename) return false;

        const token = buildPromptAttachmentToken(filename);
        const insertion = replacePromptReferenceContext(state.ui.prompt, context, token);
        const previousAttachments = this.getPromptAttachments();
        const existingAttachmentIndex = previousAttachments.findIndex((attachment) => (
            attachment?.sessionId === sessionId
            && attachment?.filename === filename
        ));
        const nextAttachment = {
            ...(existingAttachmentIndex >= 0 ? previousAttachments[existingAttachmentIndex] : {}),
            id: `${sessionId}/${filename}`,
            sessionId,
            filename,
            resolvedPath: filename,
            token,
        };
        const nextAttachments = existingAttachmentIndex >= 0
            ? previousAttachments.map((attachment, index) => (index === existingAttachmentIndex ? nextAttachment : attachment))
            : [...previousAttachments, nextAttachment];

        this.setPrompt(insertion.prompt, insertion.cursor);
        this.setPromptAttachments(nextAttachments);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({ type: "ui/status", text: `Attached ${filename}` });
        return true;
    }

    acceptSessionPromptReference(context = this.getPromptReferenceContext()) {
        if (!context || context.kind !== "sessions") return false;

        const state = this.getState();
        const sessionRows = selectSessionRows(state);
        const targetRow = sessionRows[0] || null;
        const targetSession = targetRow?.sessionId
            ? state.sessions.byId[targetRow.sessionId] || null
            : null;
        if (!targetSession?.sessionId) return false;

        const referenceText = buildPromptSessionReferenceText(targetSession);
        const insertion = replacePromptReferenceContext(state.ui.prompt, context, referenceText);
        this.setPrompt(insertion.prompt, insertion.cursor);
        this.setFocus(FOCUS_REGIONS.PROMPT);
        this.dispatch({
            type: "ui/status",
            text: `Referenced session ${shortSessionIdValue(targetSession.sessionId)}`,
        });
        return true;
    }

    setSessionFilterQuery(query = "") {
        this.dispatch({
            type: "sessions/filterQuery",
            query: String(query || ""),
        });
    }

    openSessionOwnerFilter() {
        const state = this.getState();
        const items = buildSessionOwnerFilterItems(state);
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionOwnerFilter",
                title: "Session Filter",
                previousFocus: state.ui.focusRegion,
                selectedIndex: 0,
                items,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: "Up/Down choose entry · Space toggle · Esc close",
        });
    }

    toggleSessionOwnerFilter(index = null) {
        const state = this.getState();
        const modal = state.ui.modal;
        if (!modal || modal.type !== "sessionOwnerFilter") return;
        const selectedIndex = index == null
            ? Math.max(0, Number(modal.selectedIndex) || 0)
            : Math.max(0, Number(index) || 0);
        const item = modal.items?.[selectedIndex];
        if (!item) return;
        const nextFilter = toggleOwnerFilterItem(state.sessions.ownerFilter, item, state.auth?.principal);
        this.dispatch({
            type: "sessions/ownerFilter",
            filter: nextFilter,
        });
        this.dispatch({
            type: "ui/modalSelection",
            index: selectedIndex,
        });
        this.dispatch({
            type: "ui/status",
            text: `Session filter updated: ${item.label || item.id || "selection"}`,
        });
    }

    // Keep the open Session Filter modal's entry list in sync with the live
    // session set. The item list is snapshotted into modal.items at open time
    // (it must be — the shared keyboard-nav handler indexes into it), but the
    // periodic catalog refresh mutates owners underneath it: a user whose first
    // session arrives after the modal opened would otherwise never see their
    // owner bucket without reopening. Rebuild in place, preserving the
    // highlighted row by its stable id, and only when the shape actually
    // changed (so we don't churn the modal on every 4s refresh).
    refreshOpenSessionOwnerFilterModal() {
        const state = this.getState();
        const modal = state.ui.modal;
        if (!modal || modal.type !== "sessionOwnerFilter") return;
        const nextItems = buildSessionOwnerFilterItems(state);
        const prevItems = Array.isArray(modal.items) ? modal.items : [];
        const sameShape = prevItems.length === nextItems.length
            && prevItems.every((item, i) => item?.id === nextItems[i]?.id);
        if (sameShape) return;
        const prevSelectedId = prevItems[Math.max(0, Number(modal.selectedIndex) || 0)]?.id;
        const remappedIndex = prevSelectedId != null
            ? nextItems.findIndex((item) => item.id === prevSelectedId)
            : -1;
        const nextSelectedIndex = remappedIndex >= 0
            ? remappedIndex
            : Math.max(0, Math.min(Number(modal.selectedIndex) || 0, Math.max(0, nextItems.length - 1)));
        this.dispatch({
            type: "ui/modal",
            modal: { ...modal, items: nextItems, selectedIndex: nextSelectedIndex },
        });
    }

    setFilesFilter(patch = {}) {
        this.dispatch({
            type: "files/filter",
            filter: patch,
        });
    }

    clearPromptReferenceBrowser() {
        this.promptReferenceSignature = null;
        this.promptReferenceSyncVersion += 1;
        if (this.getState().sessions.filterQuery) {
            this.setSessionFilterQuery("");
        }
        if (this.getState().files.filter?.query) {
            this.setFilesFilter({ query: "" });
        }
    }

    syncPromptReferenceBrowser() {
        const state = this.getState();
        const context = extractPromptReferenceContext(state.ui.prompt, state.ui.promptCursor);

        if (!context) {
            this.clearPromptReferenceBrowser();
            return;
        }

        if (this.promptReferenceSignature === context.signature) {
            return;
        }
        this.promptReferenceSignature = context.signature;

        if (context.kind === "sessions") {
            this.promptReferenceSyncVersion += 1;
            this.setFilesFilter({ query: "" });
            this.setSessionFilterQuery(context.query);
            return;
        }

        const sessionId = state.sessions.activeSessionId;
        this.setSessionFilterQuery("");
        this.setFilesFilter({
            scope: "selectedSession",
            query: context.query,
        });
        if (!sessionId) return;

        this.selectInspectorTab("files").catch(() => {});
        const syncVersion = ++this.promptReferenceSyncVersion;
        this.ensureFilesForScope("selectedSession").then(async () => {
            if (this.promptReferenceSyncVersion !== syncVersion) return;
            const scopedSessionIds = new Set(selectFileSessionIdsForScope(this.getState(), "selectedSession"));
            const items = selectFileBrowserItems(this.getState()).filter((item) => scopedSessionIds.has(item.sessionId));
            const nextItem = items[0] || null;
            if (!nextItem?.filename) return;
            this.dispatch({
                type: "files/select",
                sessionId: nextItem.sessionId,
                filename: nextItem.filename,
            });
            await this.ensureFilePreview(nextItem.sessionId, nextItem.filename).catch(() => {});
        }).catch(() => {});
    }

    async start({ initialSessionId = null } = {}) {
        await this.transport.start();
        const authContext = typeof this.transport.getAuthContext === "function"
            ? this.transport.getAuthContext()
            : null;
        this.dispatch({
            type: "auth/context",
            principal: authContext?.principal ?? null,
            authorization: authContext?.authorization ?? null,
        });
        if (!this.getState().sessions.ownerFilterExplicit) {
            this.dispatch({
                type: "sessions/ownerFilter",
                filter: defaultOwnerFilterForPrincipal(authContext?.principal ?? null),
            });
        }
        const logConfig = typeof this.transport.getLogConfig === "function"
            ? this.transport.getLogConfig()
            : null;
        if (logConfig) {
            this.dispatch({
                type: "logs/config",
                available: logConfig.available,
                availabilityReason: logConfig.availabilityReason,
            });
        }
        this.dispatch({
            type: "connection/ready",
            workersOnline: typeof this.transport.getWorkerCount === "function" ? this.transport.getWorkerCount() : null,
            statusText: "Connected",
        });
        // Latch the deep-link intent AFTER the default owner-filter dispatch
        // (a filter change releases the latch) and BEFORE the first refresh,
        // so the first catalog load resolves selection onto the link target.
        const deepLinkSessionId = String(initialSessionId || "").trim();
        if (deepLinkSessionId) {
            this.dispatch({ type: "sessions/navigationIntent", sessionId: deepLinkSessionId });
        }
        await this.refreshSessions();
        this.catalogTimer = setInterval(() => {
            this.refreshSessions().catch((error) => {
                this.dispatch({
                    type: "connection/error",
                    error: error?.message || String(error),
                    statusText: SESSION_REFRESH_FAILED_STATUS,
                });
            });
        }, 4000);
    }

    async stop() {
        if (this.catalogTimer) clearInterval(this.catalogTimer);
        this.catalogTimer = null;
        if (this.activeSessionDetailTimer) clearTimeout(this.activeSessionDetailTimer);
        this.activeSessionDetailTimer = null;
        this.activeSessionDetailSessionId = null;
        if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
        this.sessionRefreshTimer = null;
        this.sessionHistoryExpansionLoads.clear();
        this.sessionOrchestrationStatsLoads.clear();
        this.detachActiveSession();
        this.detachLogStream();
        await this.transport.stop();
    }

    detachActiveSession() {
        if (this.activeSessionUnsub) {
            this.activeSessionUnsub();
            this.activeSessionUnsub = null;
        }
        this.activeSessionSubscriptionId = null;
    }

    /**
     * A session no longer exists server-side (deleted locally or by another
     * client; the server answered 404). Unbind everything referencing it so
     * the detail/events/orchestration-stats loops stop instead of 404-spamming
     * on every refresh tick until reload.
     */
    handleSessionGone(sessionId) {
        if (!sessionId) return;
        // A folder row can never be "gone" from the session catalog: it is not
        // a session. Only sessions/groupsLoaded may remove one.
        if (isSessionGroupRowId(sessionId)) return;
        if (this.activeSessionSubscriptionId === sessionId) {
            this.detachActiveSession();
        }
        if (this.activeSessionDetailSessionId === sessionId && this.activeSessionDetailTimer) {
            clearTimeout(this.activeSessionDetailTimer);
            this.activeSessionDetailTimer = null;
            this.activeSessionDetailSessionId = null;
        }
        this.dispatch({ type: "sessions/gone", sessionId });
    }

    detachLogStream() {
        if (this.logUnsubscribe) {
            this.logUnsubscribe();
            this.logUnsubscribe = null;
        }
    }

    async refreshSessions() {
        // FIRST, above every early return below (a selected group or a
        // navigation-intent branch returns before the tail): the worker
        // registry must refresh on every tick of the loop that provably runs.
        this.refreshWorkerRegistryIfStale().catch(() => {});
        // Refreshes OVERLAP. The catalog loop ticks every 4s and a dozen
        // actions call this directly, while one run awaits several sequential
        // round-trips (N catalog pages, the folder list, up to two getSession
        // fetches) — easily longer than the tick. Without an ordering guard a
        // slow run applies a snapshot taken BEFORE a folder existed (or before
        // a member moved) on top of a newer one, and since groupsLoaded is
        // authoritative — "folders it omits are gone" — the folder is deleted,
        // its members reflow to the top level, and the next tick puts it back.
        // That is the flicker. Stamp each run and let only the newest apply.
        const refreshSeq = (this.sessionRefreshSeq = (this.sessionRefreshSeq || 0) + 1);
        const preRefreshState = this.getState();
        const recoveringConnection = !preRefreshState.connection.connected || Boolean(preRefreshState.connection.error);
        const shouldClearRefreshFailureBanner = preRefreshState.ui.statusText === SESSION_REFRESH_FAILED_STATUS;
        const previousActive = this.getState().sessions.activeSessionId;
        let sessions = (await loadSessionCatalogPageWindow(this.transport)).map(normalizeSessionListRow);
        // Folders are NOT merged into the session payload any more: they live
        // in their own state slice, so a session refresh cannot drop them. A
        // failed fetch is "no news" and simply leaves the slice alone.
        //
        // This still dispatches BEFORE sessions/loaded, and must: sessions/loaded
        // seeds default collapse state and the default selection from the rows
        // it can see, so with no folder rows in state it collapses nothing and
        // auto-selects a folder MEMBER — which then holds the folder open
        // forever to keep the selection visible. What it could not do from
        // state alone is judge which folders are still claimed, since the store
        // still holds the PREVIOUS membership at this point; the incoming rows
        // ride along on the action for exactly that.
        let pendingGroupRows = null;
        if (typeof this.transport.listSessionGroups === "function") {
            try {
                const groups = await this.transport.listSessionGroups();
                pendingGroupRows = (Array.isArray(groups) ? groups : []).map(sessionGroupToRow).filter(Boolean);
            } catch (error) {
                console.warn(`[PilotSwarmUi] session-group fetch failed, keeping the known folders: ${error?.message || error}`);
            }
        }
        // A pending deep-link target may be readable but absent from the
        // paged catalog window — fetch it explicitly. A definitive failure
        // (unknown or unshared: identical 404 shapes) fails the intent; the
        // reducer then refuses fallback selection so the renderer can show
        // the nav error instead of silently landing somewhere else.
        const pendingIntent = preRefreshState.sessions.navigationIntent;
        if (
            pendingIntent?.status === "pending"
            && !sessions.some((session) => session?.sessionId === pendingIntent.sessionId)
            && typeof this.transport.getSession === "function"
        ) {
            try {
                const intentSession = await this.transport.getSession(pendingIntent.sessionId);
                if (intentSession?.sessionId) {
                    sessions = [...sessions, normalizeSessionListRow(intentSession)];
                } else {
                    this.dispatch({
                        type: "sessions/navigationIntentFailed",
                        sessionId: pendingIntent.sessionId,
                        errorKind: "not_found",
                    });
                }
            } catch (error) {
                this.dispatch({
                    type: "sessions/navigationIntentFailed",
                    sessionId: pendingIntent.sessionId,
                    errorKind: classifyNavigationLoadError(error),
                });
            }
        }
        const active = previousActive;
        if (
            active
            && !isSessionGroupRowId(active)
            && !sessions.some((session) => session?.sessionId === active)
            && typeof this.transport.getSession === "function"
        ) {
            const activeSession = await this.transport.getSession(active).catch(() => null);
            if (activeSession?.sessionId) {
                sessions = [...sessions, normalizeSessionListRow(activeSession)];
            }
        }
        // Everything above is READ-ONLY on the store (bar the navigation-intent
        // failures, which are keyed to a specific session and stay true). From
        // here down the run WRITES, so a run that a newer one has overtaken
        // must stop: its snapshot is older than what the store already holds.
        if (refreshSeq !== this.sessionRefreshSeq) return;
        if (recoveringConnection) {
            this.dispatch({
                type: "connection/ready",
                workersOnline: typeof this.transport.getWorkerCount === "function" ? this.transport.getWorkerCount() : null,
                ...(shouldClearRefreshFailureBanner ? { statusText: "Connected" } : {}),
            });
        }
        if (pendingGroupRows) {
            this.dispatch({ type: "sessions/groupsLoaded", groups: pendingGroupRows, sessions });
        }
        // Canvas summaries ride the list rows (session_canvases join) — seed
        // the store so rows mark on cold load, before any session is selected
        // or any live event arrives. Never regresses what live events already
        // know; see the canvas/seed reducer.
        const canvasSeed = [];
        for (const row of sessions) {
            for (const c of Array.isArray(row?.canvases) ? row.canvases : []) {
                canvasSeed.push({ sessionId: row.sessionId, slot: c.slot, name: c.name, latestRev: c.latestRev, sizeBytes: c.sizeBytes });
            }
        }
        if (canvasSeed.length) this.dispatch({ type: "canvas/seed", entries: canvasSeed });
        this.dispatch({ type: "sessions/loaded", sessions });
        // A row that says only "waiting" says nothing anyone can act on. Which
        // limit, whose allowance, which hold, which missing name — that lives
        // in the provider reads, so take them while the list holds a wait.
        this.refreshBudgetPausesIfStale(sessions).catch(() => {});
        this.refreshOpenSessionOwnerFilterModal();
        const selected = this.getState().sessions.activeSessionId;
        const syncedIds = new Set();
        if (selected) {
            if (selected !== previousActive) {
                if (!this.getState().sessions.byId[selected]?.isGroup) {
                    const selectedIntent = this.getState().sessions.navigationIntent;
                    if (selectedIntent && selectedIntent.sessionId === selected && selectedIntent.status !== "failed") {
                        try {
                            await this.loadSession(selected);
                        } catch (error) {
                            this.dispatch({
                                type: "sessions/navigationIntentFailed",
                                sessionId: selected,
                                errorKind: classifyNavigationLoadError(error),
                            });
                        }
                    } else {
                        await this.loadSession(selected);
                    }
                }
                return;
            }
            if (this.getState().sessions.byId[selected]?.isGroup) {
                return;
            }
            const existingHistory = this.getState().history.bySessionId.get(selected);
            if (!existingHistory?.events?.length) {
                await this.ensureSessionHistory(selected, { force: true }).catch(() => {});
            }
            // Boot-restore can hydrate the selection through THIS branch
            // instead of loadSession (whether the profile poll beats the first
            // sessions refresh is a race), so the canvas snapshot must be
            // armed here too. Memoized — refreshes after the first are free.
            this.ensureCanvasSnapshot(selected).catch(() => {});
            if (this.activeSessionSubscriptionId !== selected) {
                this.attachActiveSession(selected);
            }
            await this.syncSessionDetail(selected).catch(() => {});
            await this.syncSessionEvents(selected).catch(() => {});
            syncedIds.add(selected);
            const state = this.getState();
            const activeSession = state.sessions.byId[selected] || null;
            if (activeSession?.parentSessionId && typeof this.transport.getSession === "function") {
                const siblingIds = Object.values(state.sessions.byId)
                    .filter((session) => session?.parentSessionId === activeSession.parentSessionId)
                    .map((session) => session.sessionId)
                    .filter((sessionId) => sessionId && sessionId !== selected)
                    .slice(0, 6);
                await Promise.all(siblingIds.map((sessionId) => this.syncSessionDetail(sessionId).catch(() => {})));
                for (const sessionId of siblingIds) syncedIds.add(sessionId);
            }
        }
        await this.syncVisibleSessionDetails(syncedIds).catch(() => {});
        this.ensureInspectorData().catch(() => {});
        this.evictStaleSessionState();
    }

    /**
     * Refresh the worker registry at most every 20s. Never throws.
     * Records EVERY attempt (including skips and why) so the Node Map can
     * distinguish "the refresh never ran" from "the fetch failed" — the two
     * used to look identical in the UI.
     */
    async refreshWorkerRegistryIfStale() {
        const workers = this.getState().admin?.workers;
        // The registry is fleet:admin. Polling it as a plain user is a 403
        // every few seconds and a red console for nothing.
        const role = this.getState().auth?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous" || this.getState().admin?.profile?.isAdmin === true;
        if (!isAdmin) {
            this.dispatch({ type: "admin/workers/attempt", skip: "not admin" });
            return;
        }
        if (workers?.loading) {
            this.dispatch({ type: "admin/workers/attempt", skip: "already in flight" });
            return;
        }
        if (workers?.fetchedAt && (Date.now() - workers.fetchedAt) < 20_000) {
            this.dispatch({ type: "admin/workers/attempt", skip: "fresh" });
            return;
        }
        this.dispatch({ type: "admin/workers/attempt", skip: null });
        await this.refreshAdminWorkers();
    }

    /**
     * Evict cached orchestration, executionHistory, and file-preview state for sessions
     * that are not the active session and haven't been fetched recently.
     * Keeps memory bounded when hundreds of sessions accumulate.
     */
    evictStaleSessionState() {
        const state = this.getState();
        const activeSessionId = state.sessions.activeSessionId;
        const now = Date.now();
        const STALE_MS = 60_000; // 1 minute
        const MAX_CACHED = 20;

        // Evict stale orchestration stats
        const orchEntries = Object.entries(state.orchestration.bySessionId || {});
        if (orchEntries.length > MAX_CACHED) {
            const toEvict = orchEntries
                .filter(([id, entry]) => id !== activeSessionId && !entry?.loading)
                .sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0))
                .slice(0, orchEntries.length - MAX_CACHED)
                .filter(([, entry]) => (now - (entry?.fetchedAt || 0)) > STALE_MS);
            if (toEvict.length > 0) {
                this.dispatch({ type: "orchestration/evict", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale executionHistory
        const execEntries = Object.entries(state.executionHistory?.bySessionId || {});
        if (execEntries.length > MAX_CACHED) {
            const toEvict = execEntries
                .filter(([id, entry]) => id !== activeSessionId && !entry?.loading)
                .sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0))
                .slice(0, execEntries.length - MAX_CACHED)
                .filter(([, entry]) => (now - (entry?.fetchedAt || 0)) > STALE_MS);
            if (toEvict.length > 0) {
                this.dispatch({ type: "executionHistory/evict", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale file previews (keep entries list, drop preview content)
        const fileEntries = Object.entries(state.files.bySessionId || {});
        if (fileEntries.length > MAX_CACHED) {
            const toEvict = fileEntries
                .filter(([id]) => id !== activeSessionId)
                .slice(0, fileEntries.length - MAX_CACHED);
            if (toEvict.length > 0) {
                this.dispatch({ type: "files/evictPreviews", sessionIds: toEvict.map(([id]) => id) });
            }
        }

        // Evict stale history for non-visible sessions when count is very high
        const historyEntries = [...state.history.bySessionId.entries()];
        if (historyEntries.length > MAX_CACHED * 2) {
            const toEvict = historyEntries
                .filter(([id]) => id !== activeSessionId)
                .slice(0, historyEntries.length - MAX_CACHED * 2)
                .map(([id]) => id);
            if (toEvict.length > 0) {
                this.dispatch({ type: "history/evict", sessionIds: toEvict });
            }
        }
    }

    async syncVisibleSessionDetails(excludedIds = new Set()) {
        if (typeof this.transport.getSession !== "function") return;

        const state = this.getState();
        const layout = computeLegacyLayout(
            {
                width: state.ui.layout.viewportWidth,
                height: state.ui.layout.viewportHeight,
            },
            state.ui.layout.paneAdjust,
            state.ui.promptRows ?? getPromptInputRows(state.ui.prompt),
            state.ui.layout.sessionPaneAdjust,
            state.ui.layout.activityPaneAdjust,
            state.ui.fullscreenPane,
        );
        const maxRows = this.getSessionListMaxRows(layout);
        const visibleRows = selectVisibleSessionRows(state, maxRows);
        const sessionIds = [...new Set(
            visibleRows
                .map((row) => row.sessionId)
                // Folder rows are visible rows but not sessions.
                .filter((sessionId) => sessionId && !isSessionGroupRowId(sessionId) && !excludedIds.has(sessionId)),
        )];
        if (sessionIds.length === 0) return;

        await Promise.all(sessionIds.map((sessionId) => this.syncSessionDetail(sessionId).catch(() => {})));
    }

    /**
     * Append the events recorded after `afterSeq` to an in-memory history.
     * Returns the merged history, the unchanged history when there is
     * nothing new, or null when the delta is clamped (caller reloads).
     */
    async catchUpSessionHistory(sessionId, existingHistory, afterSeq) {
        const CATCH_UP_PAGE_LIMIT = 1000;
        let newEvents;
        try {
            newEvents = await this.transport.getSessionEvents(sessionId, afterSeq, CATCH_UP_PAGE_LIMIT);
        } catch (error) {
            if (isSessionGoneError(error)) {
                this.handleSessionGone(sessionId);
            }
            return null;
        }
        if (!Array.isArray(newEvents) || newEvents.length >= CATCH_UP_PAGE_LIMIT) {
            return null;
        }
        if (newEvents.length === 0) {
            return existingHistory;
        }
        let history = existingHistory;
        for (const event of newEvents) {
            history = appendEventToHistory(history, event);
        }
        history = {
            ...history,
            // Appends must never shrink the expanded window's clamp budget.
            loadedEventLimit: Math.max(
                Number(existingHistory.loadedEventLimit) || 0,
                Array.isArray(history.events) ? history.events.length : 0,
            ),
        };
        this.dispatch({ type: "history/set", sessionId, history });
        for (const event of newEvents) {
            this.reconcileOutboxAgainstEvent(sessionId, event);
        }
        const derivedModel = extractSessionModelFromEvents(newEvents);
        const currentSession = this.getState().sessions.byId[sessionId] || { sessionId };
        const derivedContextUsage = extractSessionContextUsageFromEvents(currentSession.contextUsage, newEvents);
        if (derivedModel || derivedContextUsage) {
            this.dispatch({
                type: "sessions/merged",
                session: {
                    sessionId,
                    ...(derivedModel || {}),
                    ...(derivedContextUsage ? { contextUsage: derivedContextUsage } : {}),
                },
            });
        }
        return history;
    }

    async ensureSessionHistory(sessionId, { force = false } = {}) {
        if (!sessionId) return null;
        const existingHistory = this.getState().history.bySessionId.get(sessionId);
        const requestedLimit = Math.min(
            HISTORY_REENTRY_MAX_EVENTS,
            Math.max(
                DEFAULT_HISTORY_EVENT_LIMIT,
                Number(existingHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
            ),
        );
        if (!force && existingHistory?.events) {
            return existingHistory;
        }
        if (!force && this.sessionHistoryLoads.has(sessionId)) {
            return this.sessionHistoryLoads.get(sessionId);
        }

        // Re-entry catch-up: when the expanded window is already in memory,
        // fetch only the delta after lastSeq and append — the user's pulled-in
        // older history (and its cursor) survives switching sessions. Fall
        // back to a full window reload when the delta hits the server's
        // 1000-row page clamp (too far behind to append reliably).
        const catchUpFrom = Number(existingHistory?.lastSeq) || 0;
        if (force && catchUpFrom > 0 && Array.isArray(existingHistory?.events) && existingHistory.events.length > 0) {
            const caughtUp = await this.catchUpSessionHistory(sessionId, existingHistory, catchUpFrom);
            if (caughtUp) return caughtUp;
        }

        const loadPromise = (async () => {
            let events;
            try {
                events = await this.transport.getSessionEvents(sessionId, undefined, requestedLimit);
            } catch (error) {
                if (isSessionGoneError(error)) {
                    this.handleSessionGone(sessionId);
                    return null;
                }
                throw error;
            }
            const history = {
                ...buildHistoryModel(events, { requestedLimit }),
                lastSeq: events[events.length - 1]?.seq || 0,
            };
            this.dispatch({
                type: "history/set",
                sessionId,
                history,
            });
            // Bulk-loaded events bypass mergeSessionEvent, so reconcile the
            // outbox here too. Without this, an outbox item whose durable
            // user.message arrived before the page subscribed (e.g., because
            // ensureSessionHistory ran first on attach, or after a force
            // refresh) stays stuck as "queued" or "cancelling" forever.
            for (const event of events || []) {
                this.reconcileOutboxAgainstEvent(sessionId, event);
            }
            const derivedModel = extractSessionModelFromEvents(events);
            const currentSession = this.getState().sessions.byId[sessionId] || { sessionId };
            const derivedContextUsage = extractSessionContextUsageFromEvents(currentSession.contextUsage, events);
            if (derivedModel || derivedContextUsage) {
                this.dispatch({
                    type: "sessions/merged",
                    session: {
                        sessionId,
                        ...(derivedModel || {}),
                        ...(derivedContextUsage ? { contextUsage: derivedContextUsage } : {}),
                    },
                });
            }
            return history;
        })()
            .finally(() => {
                this.sessionHistoryLoads.delete(sessionId);
            });

        this.sessionHistoryLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async ensureInspectorData(targetTab = this.getState().ui.inspectorTab) {
        if (targetTab === "sequence") {
            const activeSessionId = this.getState().sessions.activeSessionId;
            if (!activeSessionId) return;
            await this.ensureSessionHistory(activeSessionId).catch(() => {});
            await this.ensureOrchestrationStats(activeSessionId).catch(() => {});
            return;
        }
        if (targetTab === "nodes") {
            // Registry-first: the node list leads with the worker registry
            // (specs, phases, health). Refresh it on the same cadence the
            // history loads ride, throttled to the ~20s heartbeat interval;
            // non-admin transports fail quietly and the view degrades to
            // history-derived nodes.
            // No silent skip here: refreshAdminWorkers itself reports every
            // outcome (missing method, error, empty) so the pane can never sit
            // on a pristine "not fetched yet" state with nothing explaining it.
            void this.refreshWorkerRegistryIfStale().catch(() => {});
            // Only fetch history for visible session rows — not the entire catalog.
            // With hundreds of sessions, fetching all of them every 4s causes unbounded memory growth.
            const state = this.getState();
            const layout = computeLegacyLayout(
                {
                    width: state.ui.layout.viewportWidth,
                    height: state.ui.layout.viewportHeight,
                },
                state.ui.layout.paneAdjust,
                state.ui.promptRows ?? getPromptInputRows(state.ui.prompt),
                state.ui.layout.sessionPaneAdjust,
                state.ui.layout.activityPaneAdjust,
                state.ui.fullscreenPane,
            );
            const maxRows = this.getSessionListMaxRows(layout);
            const visibleRows = selectVisibleSessionRows(state, maxRows);
            const sessionIds = [...new Set(
                visibleRows
                    .map((row) => row.sessionId)
                    .filter(Boolean),
            )];
            if (sessionIds.length === 0) return;
            await Promise.allSettled(sessionIds.map((sessionId) => this.ensureSessionHistory(sessionId)));
            return;
        }
        if (targetTab === "files") {
            await this.ensureFilesForScope(selectFilesScope(this.getState()));
        }
        if (targetTab === "history") {
            const activeSessionId = this.getState().sessions.activeSessionId;
            const current = activeSessionId
                ? this.getState().executionHistory?.bySessionId?.[activeSessionId] || null
                : null;
            if (activeSessionId && !current) {
                await this.ensureExecutionHistory(activeSessionId);
            }
        }
        if (targetTab === "stats") {
            await this.ensureSessionStats().catch(() => {});
            await this.ensureFleetStats().catch(() => {});
        }
    }

    async ensureOrchestrationStats(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.getOrchestrationStats !== "function") return null;

        const current = this.getState().orchestration.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return current;
        if (
            !force
            && current
            && Number.isFinite(current.fetchedAt)
            && (now - current.fetchedAt) < ORCHESTRATION_STATS_REFRESH_MS
        ) {
            return current;
        }
        if (!force && this.sessionOrchestrationStatsLoads.has(sessionId)) {
            return this.sessionOrchestrationStatsLoads.get(sessionId);
        }

        this.dispatch({ type: "orchestration/statsLoading", sessionId });
        const loadPromise = (async () => {
            try {
                const stats = await this.transport.getOrchestrationStats(sessionId);
                this.dispatch({
                    type: "orchestration/statsLoaded",
                    sessionId,
                    stats,
                    fetchedAt: Date.now(),
                });
                return this.getState().orchestration.bySessionId?.[sessionId] || null;
            } catch (error) {
                if (isSessionGoneError(error)) {
                    this.handleSessionGone(sessionId);
                    return null;
                }
                this.dispatch({
                    type: "orchestration/statsError",
                    sessionId,
                    error: error?.message || String(error),
                    fetchedAt: Date.now(),
                });
                return null;
            }
        })().finally(() => {
            this.sessionOrchestrationStatsLoads.delete(sessionId);
        });
        this.sessionOrchestrationStatsLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async ensureSessionStats({ force = false } = {}) {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId || typeof this.transport.getSessionMetricSummary !== "function") return;

        const current = this.getState().sessionStats?.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return;
        if (!force && current && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < SESSION_STATS_REFRESH_MS) return;

        this.dispatch({ type: "sessionStats/loading", sessionId });
        try {
            const [summary, tokensByModel, treeStats, skillUsage, treeSkillUsage, factsStats, treeFactsStats] = await Promise.all([
                this.transport.getSessionMetricSummary(sessionId),
                typeof this.transport.getSessionTokensByModel === "function"
                    ? this.transport.getSessionTokensByModel(sessionId).catch(() => [])
                    : [],
                typeof this.transport.getSessionTreeStats === "function"
                    ? this.transport.getSessionTreeStats(sessionId)
                    : null,
                typeof this.transport.getSessionSkillUsage === "function"
                    ? this.transport.getSessionSkillUsage(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionTreeSkillUsage === "function"
                    ? this.transport.getSessionTreeSkillUsage(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionFactsStats === "function"
                    ? this.transport.getSessionFactsStats(sessionId).catch(() => null)
                    : null,
                typeof this.transport.getSessionTreeFactsStats === "function"
                    ? this.transport.getSessionTreeFactsStats(sessionId).catch(() => null)
                    : null,
            ]);
            this.dispatch({ type: "sessionStats/loaded", sessionId, summary, tokensByModel, treeStats, skillUsage, treeSkillUsage, factsStats, treeFactsStats });
        } catch {
            this.dispatch({ type: "sessionStats/loaded", sessionId, summary: null, tokensByModel: [], treeStats: null, skillUsage: null, treeSkillUsage: null, factsStats: null, treeFactsStats: null });
        }
    }

    async ensureFleetStats({ force = false } = {}) {
        if (typeof this.transport.getFleetStats !== "function") return;        const current = this.getState().fleetStats;
        const now = Date.now();
        if (!force && current?.loading) return;
        if (!force && current?.data && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < FLEET_STATS_REFRESH_MS) return;

        this.dispatch({ type: "fleetStats/loading" });
        try {
            const since = new Date(Date.now() - FLEET_STATS_DEFAULT_WINDOW_DAYS * 86400_000);
            // Include soft-deleted sessions in the rolling window so the
            // aggregates reflect work that *happened* in the last 30 days,
            // not just sessions that still exist. Deleted-but-recent
            // sessions are still part of the operator's reality (cost,
            // tokens, skill usage) until the underlying rows are pruned.
            const fleetOpts = { since, includeDeleted: true };
            const [data, userStats, skillUsage, retrievalUsage, sharedFactsStats, factsTombstoneStats] = await Promise.all([
                this.transport.getFleetStats(fleetOpts),
                typeof this.transport.getUserStats === "function"
                    ? this.transport.getUserStats(fleetOpts).catch(() => null)
                    : null,
                typeof this.transport.getFleetSkillUsage === "function"
                    ? this.transport.getFleetSkillUsage(fleetOpts).catch(() => null)
                    : null,
                typeof this.transport.getFleetRetrievalUsage === "function"
                    ? this.transport.getFleetRetrievalUsage(fleetOpts).catch(() => null)
                    : null,
                typeof this.transport.getSharedFactsStats === "function"
                    ? this.transport.getSharedFactsStats().catch(() => null)
                    : null,
                typeof this.transport.getFactsTombstoneStats === "function"
                    ? this.transport.getFactsTombstoneStats().catch(() => null)
                    : null,
            ]);
            this.dispatch({ type: "fleetStats/loaded", data, userStats, skillUsage, retrievalUsage, sharedFactsStats, factsTombstoneStats });
        } catch {
            this.dispatch({ type: "fleetStats/loaded", data: null, userStats: null, skillUsage: null, retrievalUsage: null, sharedFactsStats: null, factsTombstoneStats: null });
        }
    }

    // ─── Admin Console ─────────────────────────────────────────

    /**
     * Open the Admin Console (replaces sessions+chat with the per-user
     * admin view) and refresh the user profile so the UI is current.
     */
    async openAdminConsole() {
        this.dispatch({ type: "admin/visibility", visible: true });
        await this.refreshAdminProfile().catch(() => {});
        void this.refreshAdminModelProviders().catch(() => {});
        void this.refreshAdminAgentPackages().catch(() => {});
    }

    /** Close the Admin Console and return to the standard workspace. */
    closeAdminConsole() {
        this.dispatch({ type: "admin/visibility", visible: false });
    }

    /**
     * Land on a freshly created session. Selecting it is not enough: the
     * Admin Console REPLACES the workspace, so creating from there left the
     * new session selected behind a pane that does not show it — the create
     * appeared to do nothing but print a status line. Any workspace-replacing
     * surface has to be dismissed here, not just the focus moved.
     */
    revealCreatedSession() {
        if (this.getState().admin?.visible) this.closeAdminConsole();
        this.setFocus(FOCUS_REGIONS.PROMPT);
    }

    /**
     * Re-fetch the current user's profile (settings + ghcp key-set
     * flag). Safe to call repeatedly; updates state in place.
     */
    async refreshAdminProfile() {
        if (typeof this.transport.getCurrentUserProfile !== "function") {
            this.dispatch({ type: "admin/profile/loadFailed", error: "Admin Console is not available on this transport." });
            return null;
        }
        this.dispatch({ type: "admin/profile/loading" });
        try {
            const profile = await this.transport.getCurrentUserProfile();
            this.dispatch({ type: "admin/profile/loaded", profile });
            await this.refreshSystemGhcpKeyStatus(profile);
            return profile || null;
        } catch (error) {
            this.dispatch({ type: "admin/profile/loadFailed", error: error?.message || String(error) });
            return null;
        }
    }

    /**
     * Load the SYSTEM user's Copilot key status (admins only). Quietly a
     * no-op when the caller is not admin or the transport predates the
     * feature, so the Admin Console degrades to the per-user-only view.
     */
    async refreshSystemGhcpKeyStatus(profile = null) {
        const effective = profile || this.getState().admin?.profile || null;
        if (!effective?.isAdmin) return null;
        if (typeof this.transport.getSystemGitHubCopilotKeyStatus !== "function") return null;
        this.dispatch({ type: "admin/systemGhcpKey/loading" });
        try {
            const status = await this.transport.getSystemGitHubCopilotKeyStatus();
            this.dispatch({ type: "admin/systemGhcpKey/loaded", status });
            return status || null;
        } catch (error) {
            this.dispatch({ type: "admin/systemGhcpKey/loadFailed", error: error?.message || String(error) });
            return null;
        }
    }

    /**
     * Admin-only: switch the key editor between "your key" and
     * "System key" (the key ownerless system sessions run on).
     */
    setAdminGhcpKeyStoreAsSystem(value) {
        if (value && !this.getState().admin?.profile?.isAdmin) return;
        this.dispatch({ type: "admin/ghcpKey/setSystemTarget", value: Boolean(value) });
    }

    async refreshAdminModelProviders() {
        const required = ["listProviders", "getModelDefaults"];
        if (required.some((name) => typeof this.transport[name] !== "function")) {
            this.dispatch({ type: "admin/modelProviders/loadFailed", error: "Model provider management is not available on this transport." });
            return null;
        }
        this.dispatch({ type: "admin/modelProviders/loading" });
        try {
            const [providerResult, modelResult, defaults] = await Promise.all([
                this.transport.listProviders(),
                typeof this.transport.getModelsByProvider === "function"
                    ? this.transport.getModelsByProvider()
                    : this.transport.listModels(),
                this.transport.getModelDefaults(),
            ]);
            const models = Array.isArray(modelResult)
                && modelResult.some((entry) => Array.isArray(entry?.models))
                ? modelResult.flatMap((group) => (group.models || []).map((model) => ({
                    ...model,
                    providerId: group.providerId,
                    providerType: group.type || model.providerType,
                })))
                : modelResult;
            const providers = Array.isArray(providerResult)
                ? providerResult
                : (Array.isArray(providerResult?.providers) ? providerResult.providers : []);
            this.dispatch({
                type: "admin/modelProviders/loaded",
                providers,
                models: Array.isArray(models) ? models : [],
                defaults,
            });
            return { providers, models, defaults };
        } catch (error) {
            this.dispatch({ type: "admin/modelProviders/loadFailed", error: error?.message || String(error) });
            return null;
        }
    }

    async _runAdminModelProviderMutation(pending, run) {
        this.dispatch({ type: "admin/modelProviders/mutationPending", pending });
        try {
            const result = await run();
            this.dispatch({ type: "admin/modelProviders/mutationDone" });
            await this.refreshAdminModelProviders();
            return { ok: true, result: result ?? null, error: null };
        } catch (error) {
            const message = error?.message || String(error);
            this.dispatch({ type: "admin/modelProviders/mutationFailed", error: message });
            return { ok: false, result: null, error: message };
        }
    }

    async createAdminProvider({ name, type, credentials, baseUrl = null, shared = false } = {}) {
        const op = shared ? "createProvider" : "createMyProvider";
        if (typeof this.transport[op] !== "function") {
            this.dispatch({ type: "admin/modelProviders/mutationFailed", error: "Provider creation is not available on this transport." });
            return { ok: false, result: null, error: "Provider creation is not available on this transport." };
        }
        return this._runAdminModelProviderMutation("create", () => this.transport[op]({
            name, type, credentials, baseUrl,
        }));
    }

    async updateAdminProviderCredential({ name, credentials } = {}) {
        if (typeof this.transport.updateMyProviderCredential !== "function") {
            const error = "Provider credential updates are not available on this transport.";
            this.dispatch({ type: "admin/modelProviders/mutationFailed", error });
            return { ok: false, result: null, error };
        }
        return this._runAdminModelProviderMutation("updateCredential", () =>
            this.transport.updateMyProviderCredential({ name, credentials }));
    }

    async deleteAdminProvider(name, { shared = false } = {}) {
        const op = shared ? "deleteProvider" : "deleteMyProvider";
        if (typeof this.transport[op] !== "function") {
            return { ok: false, result: null, error: "Provider deletion is not available on this transport." };
        }
        return this._runAdminModelProviderMutation("delete", () => this.transport[op](name));
    }

    async setAdminProviderSystemUse(provider, enabled) {
        if (typeof this.transport.setProviderSystemUse !== "function") {
            return { ok: false, result: null, error: "System-use controls are not available on this transport." };
        }
        return this._runAdminModelProviderMutation("systemUse", () => this.transport.setProviderSystemUse({
            provider, enabled: enabled === true,
        }));
    }

    async setAdminModelDefault(scope, choice = null) {
        if (typeof this.transport.setModelDefault !== "function") {
            return { ok: false, result: null, error: "Model defaults are not available on this transport." };
        }
        return this._runAdminModelProviderMutation(`${scope}Default`, () => this.transport.setModelDefault({
            scope,
            provider: choice?.provider ?? null,
            model: choice?.qualifiedName ?? choice?.model ?? null,
            reasoningEffort: choice?.reasoningEffort ?? choice?.defaultReasoningEffort ?? null,
            contextTier: choice?.contextTier ?? choice?.defaultContextTier ?? null,
        }));
    }

    async setAdminSystemModelDefault(choice = null, { restartDisposition = null } = {}) {
        if (typeof this.transport.setSystemModelDefault !== "function") {
            return { ok: false, result: null, error: "The system model default is not available on this transport." };
        }
        return this._runAdminModelProviderMutation("systemDefault", () => this.transport.setSystemModelDefault({
            provider: choice?.provider ?? null,
            model: choice?.qualifiedName ?? choice?.model ?? null,
            reasoningEffort: choice?.reasoningEffort ?? choice?.defaultReasoningEffort ?? null,
            contextTier: choice?.contextTier ?? choice?.defaultContextTier ?? null,
            restartExisting: restartDisposition ? { disposition: restartDisposition } : false,
        }));
    }

    async setAdminSystemAgentModel(agentId, choice) {
        if (typeof this.transport.setSystemSessionModel !== "function") {
            return { ok: false, result: null, error: "System-agent overrides are not available on this transport." };
        }
        return this._runAdminModelProviderMutation("systemOverride", () => this.transport.setSystemSessionModel({
            agentId,
            provider: choice?.provider,
            model: choice?.qualifiedName ?? choice?.model,
            reasoningEffort: choice?.reasoningEffort ?? choice?.defaultReasoningEffort ?? null,
            contextTier: choice?.contextTier ?? choice?.defaultContextTier ?? null,
        }));
    }

    async clearAdminSystemAgentModel(agentId) {
        if (typeof this.transport.clearSystemSessionModel !== "function") {
            return { ok: false, result: null, error: "System-agent overrides are not available on this transport." };
        }
        return this._runAdminModelProviderMutation("systemOverride", () => this.transport.clearSystemSessionModel(agentId));
    }

    beginAdminCreateProvider({ shared = false } = {}) {
        const providers = this.getState().admin?.modelProviders || {};
        const typeId = (providers.models || []).find((model) => /github/i.test(model?.providerId || ""))?.providerId
            || providers.models?.[0]?.providerId
            || "github-copilot";
        const taken = new Set((providers.providers || []).map((provider) => String(provider?.name || "").toLowerCase()));
        const subject = String(this.getState().admin?.profile?.subject || "").replace(/[^A-Za-z0-9]/gu, "").slice(-10).toLowerCase();
        const base = subject ? `ghcp-${subject}` : "my-ghcp";
        let name = base;
        let suffix = 2;
        while (taken.has(name.toLowerCase())) {
            name = `${base}-${suffix}`;
            suffix += 1;
        }
        this.dispatch({ type: "admin/modelProviders/createBegin", name, typeId, shared, mode: "create" });
    }

    beginAdminCreateGithubProvider() {
        this.beginAdminCreateProvider({ shared: false });
    }

    beginAdminUpdateProviderCredential(provider) {
        if (!provider?.name || provider.class === "shared") return;
        this.dispatch({
            type: "admin/modelProviders/createBegin",
            name: provider.name,
            typeId: provider.typeId,
            shared: false,
            mode: "update",
            stage: "credential",
        });
    }

    cycleAdminProviderCreateType() {
        const providers = selectAdminConsole(this.getState()).modelProviders;
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving || create.stage !== "name") return;
        const types = providers.providerTypes || [];
        if (!types.length) return;
        const index = Math.max(0, types.findIndex((type) => type.id === create.typeId));
        this.dispatch({ type: "admin/modelProviders/createType", typeId: types[(index + 1) % types.length].id });
    }

    setAdminProviderCreateDraft(draft, cursorIndex = String(draft || "").length) {
        this.dispatch({ type: "admin/modelProviders/createDraft", draft, cursorIndex });
    }

    insertAdminProviderCreateText(text) {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving) return;
        const sanitized = String(text || "").replace(/\r?\n/gu, "");
        const next = insertPromptTextAtCursor(create.draft || "", create.cursorIndex || 0, sanitized);
        this.setAdminProviderCreateDraft(next.prompt, next.cursor);
    }

    deleteAdminProviderCreateChar() {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving) return;
        const next = deletePromptCharBackward(create.draft || "", create.cursorIndex || 0);
        this.setAdminProviderCreateDraft(next.prompt, next.cursor);
    }

    moveAdminProviderCreateCursor(delta) {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving) return;
        const draft = create.draft || "";
        this.setAdminProviderCreateDraft(draft, clampPromptCursor(draft, (create.cursorIndex || 0) + delta));
    }

    moveAdminProviderCreateCursorToBoundary(kind) {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving) return;
        const draft = create.draft || "";
        this.setAdminProviderCreateDraft(draft, kind === "start" ? 0 : draft.length);
    }

    advanceAdminProviderCreate() {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving || create.stage !== "name") return;
        const name = String(create.draft || "").trim();
        if (!name || name.length > 64 || !/^[A-Za-z0-9._-]+$/u.test(name)) {
            this.dispatch({ type: "admin/modelProviders/createFailed", error: "Use 1-64 letters, numbers, dots, dashes, or underscores for the provider name." });
            return;
        }
        this.dispatch({ type: "admin/modelProviders/createCredential", name });
    }

    async saveAdminProviderCreate() {
        const create = this.getState().admin?.modelProviders?.create;
        if (!create?.editing || create.saving || create.stage !== "credential") return;
        const credential = String(create.draft || "").trim();
        if (!credential) {
            this.dispatch({ type: "admin/modelProviders/createFailed", error: "Enter a provider credential." });
            return;
        }
        const input = {
            name: create.name,
            type: create.typeId,
            credentials: /github/i.test(create.typeId) ? { githubToken: credential } : { apiKey: credential },
            shared: create.shared === true,
        };
        // Clear the credential from shared state before any network await.
        this.dispatch({ type: "admin/modelProviders/createSaving" });
        const outcome = create.mode === "update"
            ? await this.updateAdminProviderCredential({ name: input.name, credentials: input.credentials })
            : await this.createAdminProvider(input);
        this.dispatch(outcome?.ok
            ? { type: "admin/modelProviders/createEnd" }
            : { type: "admin/modelProviders/createFailed", error: outcome?.error });
    }

    cancelAdminProviderCreate() {
        this.dispatch({ type: "admin/modelProviders/createEnd" });
    }

    setAdminModelProviderSelection({ focus, providerName, agentId } = {}) {
        this.dispatch({ type: "admin/modelProviders/select", focus, providerName, agentId });
    }

    setAdminModelProviderPage(page) {
        if (page === "shared" && !this.getState().admin?.profile?.isAdmin) return;
        this.dispatch({ type: "admin/modelProviders/page", page });
    }

    stepAdminModelProviderSelection(delta) {
        const view = selectAdminConsole(this.getState()).modelProviders;
        const focus = view.selection?.focus === "agents" ? "agents" : "providers";
        const rows = focus === "agents"
            ? view.systemAgentRoutes
            : (view.page === "shared" ? view.sharedProviders : view.myProviders);
        if (!rows.length) return;
        const selectedId = focus === "agents" ? view.selection?.agentId : view.selection?.providerName;
        let index = rows.findIndex((row) => (focus === "agents" ? row.agentId : row.name) === selectedId);
        if (index < 0) index = 0;
        const next = rows[(index + delta + rows.length) % rows.length];
        this.setAdminModelProviderSelection(focus === "agents"
            ? { focus, agentId: next.agentId }
            : { focus, providerName: next.name });
    }

    async toggleSelectedAdminProviderSystemUse() {
        const view = selectAdminConsole(this.getState()).modelProviders;
        const provider = view.myProviders.find((row) => row.name === view.selection?.providerName);
        if (!provider || !this.getState().admin?.profile?.isAdmin) return;
        return this.setAdminProviderSystemUse(provider.name, !provider.systemUseEnabled);
    }

    async deleteSelectedAdminProvider() {
        const providers = selectAdminConsole(this.getState()).modelProviders;
        const selected = [...providers.myProviders, ...providers.sharedProviders]
            .find((provider) => provider.name === providers.selection?.providerName);
        if (!selected) return;
        return this.deleteAdminProvider(selected.name, { shared: selected.class === "shared" });
    }

    requestDeleteSelectedAdminProvider() {
        const providers = selectAdminConsole(this.getState()).modelProviders;
        const selected = [...providers.myProviders, ...providers.sharedProviders]
            .find((provider) => provider.name === providers.selection?.providerName);
        if (!selected) return;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "confirm",
                title: "Delete Model Provider",
                message: `Delete ${selected.name}? Sessions using it will wait until that provider name exists again.`,
                confirmLabel: "Delete Provider",
                action: "deleteAdminProvider",
                previousFocus: FOCUS_REGIONS.ADMIN,
            },
        });
    }

    async cycleAdminModelDefault(scope, { restartDisposition = null } = {}) {
        const providers = selectAdminConsole(this.getState()).modelProviders;
        const choices = scope === "user" ? providers.userChoices
            : scope === "cluster" ? providers.clusterChoices : providers.systemChoices;
        const current = scope === "user" ? providers.mySessionDefault?.configured?.model
            : scope === "cluster" ? providers.clusterSessionDefault?.configured?.model
                : providers.systemSessionDefault?.configured?.model;
        const values = [null, ...choices];
        const index = Math.max(0, values.findIndex((choice) => choice?.qualifiedName === current));
        const next = values[(index + 1) % values.length];
        if (scope === "system") return this.setAdminSystemModelDefault(next, { restartDisposition });
        return this.setAdminModelDefault(scope, next);
    }

    async cycleSelectedAdminSystemAgentOverride() {
        const providers = selectAdminConsole(this.getState()).modelProviders;
        const route = providers.systemAgentRoutes.find((row) => row.agentId === providers.selection?.agentId)
            || providers.systemAgentRoutes[0];
        if (!route) return;
        const values = [null, ...providers.systemChoices];
        const current = route.override?.model || null;
        const index = Math.max(0, values.findIndex((choice) => choice?.qualifiedName === current));
        const next = values[(index + 1) % values.length];
        return next
            ? this.setAdminSystemAgentModel(route.agentId, next)
            : this.clearAdminSystemAgentModel(route.agentId);
    }

    // ── Agent packages (Admin → Agents) ──────────────────────────

    setAdminSection(section) {
        this.dispatch({ type: "admin/section", section });
        if (section === "providers") {
            const providers = this.getState().admin?.modelProviders;
            if (!providers?.fetchedAt) void this.refreshAdminModelProviders().catch(() => {});
        }
        if (section === "packages") {
            const pkgs = this.getState().admin?.packages;
            if (!pkgs?.fetchedAt) void this.refreshAdminAgentPackages().catch(() => {});
        }
        if (section === "workers") {
            // Always refetch on entry: liveness is heartbeat recency, so rows
            // fetched minutes ago render as a dead fleet ("0 live").
            void this.refreshAdminWorkers().catch(() => {});
        }
    }

    /** Node Map: select a node (toggles off when re-selected). Scopes Activity. */
    selectNodeMapNode(label) {
        this.dispatch({ type: "ui/nodeMapSelect", label: label ? String(label) : null });
    }

    /** Reload the worker registry (Admin → Workers). Admin-gated server-side. */
    async refreshAdminWorkers() {
        if (typeof this.transport.listWorkers !== "function") {
            this.dispatch({ type: "admin/workers/loadFailed", error: "The worker registry is not available on this deployment." });
            return;
        }
        this.dispatch({ type: "admin/workers/loading" });
        try {
            // Bounded on purpose: a request that neither resolves nor rejects
            // (wedged token refresh, dead socket) left the Node Map in a
            // permanent "not fetched yet" limbo. Ten seconds is an answer.
            const list = await Promise.race([
                Promise.resolve().then(() => this.transport.listWorkers()),
                new Promise((_, reject) => {
                    const t = setTimeout(() => reject(new Error("request timed out after 10s (connection or auth renewal wedged — try a hard refresh)")), 10_000);
                    if (typeof t?.unref === "function") t.unref();
                }),
            ]);
            console.info(`[PilotSwarmUi] worker registry: ${Array.isArray(list) ? list.length : 0} row(s)`);
            this.dispatch({ type: "admin/workers/loaded", list });
        } catch (error) {
            // Loud on purpose: the Node Map silently degrading to
            // activity-derived nodes hid a real fetch failure in prod.
            console.warn(`[PilotSwarmUi] worker-registry fetch failed: ${error?.message || error}`);
            this.dispatch({ type: "admin/workers/loadFailed", error: error?.message || String(error) });
        }
    }

    /** Reload the package list + sources (+ fleet state when permitted). */
    async refreshAdminAgentPackages() {
        if (typeof this.transport.listAgentPackages !== "function") {
            this.dispatch({ type: "admin/packages/loadFailed", error: "Agent packages are not available on this deployment." });
            return;
        }
        this.dispatch({ type: "admin/packages/loading" });
        try {
            const [list, workerState] = await Promise.all([
                this.transport.listAgentPackages(),
                typeof this.transport.listAgentWorkerState === "function"
                    ? this.transport.listAgentWorkerState().catch(() => [])
                    : [],
            ]);
            this.dispatch({ type: "admin/packages/loaded", list, workerState });
        } catch (error) {
            this.dispatch({ type: "admin/packages/loadFailed", error: error?.message || String(error) });
        }
    }

    /**
     * Select a package: loads its detail and workspace tree.
     *
     * `selector` = { scope, owner? } from the clicked ROW. One name can be
     * two packages at once (scope shadowing: a shared copy plus a user
     * copy), and without the selector every read here resolved "own copy
     * first" — both rows showed the same history, and actions could land on
     * the copy the user was not looking at.
     */
    async selectAdminPackage(name, selector = null) {
        this.dispatch({ type: "admin/packages/select", name, selector });
        if (!name) return;
        // Selection token minted by the reducer just now; every response from
        // this selection carries it so a slow response for another COPY of
        // the same name (scope shadowing) can never land on this one.
        const seq = this.getState().admin?.packages?.selectionSeq ?? 0;
        await Promise.all([
            (async () => {
                try {
                    const detail = await this.transport.getAgentPackage(name, selector);
                    if (!detail) throw new Error(`package "${name}" not found`);
                    this.dispatch({ type: "admin/packages/detail/loaded", name, seq, detail });
                } catch (error) {
                    this.dispatch({ type: "admin/packages/detail/loadFailed", name, seq, error: error?.message || String(error) });
                }
            })(),
            (async () => {
                try {
                    const tree = await this.transport.getAgentPackageTree(name, null, selector);
                    // A slower tree for a PREVIOUS selection must not clobber
                    // the current package's workspace (stale-response race).
                    if ((this.getState().admin?.packages?.selectionSeq ?? 0) !== seq) return;
                    this.dispatch({ type: "admin/packages/tree/loaded", name, seq, tree });
                    // The package's own CHANGELOG, when it ships one. Loaded
                    // alongside the tree rather than on demand because it is
                    // the first thing a reviewer wants: what changed, why, and
                    // whether an agent or a human authored it.
                    const hasChangelog = tree?.files?.some((f) => f.path === "CHANGELOG.md");
                    if (hasChangelog && typeof this.transport.getAgentPackageFile === "function") {
                        void (async () => {
                            try {
                                const file = await this.transport.getAgentPackageFile(name, null, "CHANGELOG.md", selector);
                                if ((this.getState().admin?.packages?.selectionSeq ?? 0) !== seq) return;
                                this.dispatch({
                                    type: "admin/packages/changelog/loaded",
                                    name,
                                    seq,
                                    content: typeof file === "string" ? file : (file?.content ?? file?.text ?? ""),
                                });
                            } catch {
                                // A missing/unreadable changelog is not an error
                                // worth interrupting package browsing for.
                            }
                        })();
                    } else {
                        this.dispatch({ type: "admin/packages/changelog/loaded", name, seq, content: null });
                    }
                    // Default preview: plugin.json (always present in a valid package).
                    const first = tree?.files?.find((f) => f.path === "plugin.json") ?? tree?.files?.[0];
                    if (first) void this.selectAdminPackageFile(first.path);
                } catch (error) {
                    this.dispatch({ type: "admin/packages/tree/loadFailed", name, seq, error: error?.message || String(error) });
                }
            })(),
        ]);
    }

    /** TUI keyboard selection: move through the settings-tree package rows. */
    async stepAdminPackageSelection(delta) {
        const pkgs = this.getState().admin?.packages;
        if (!pkgs?.list?.length) return;
        // Same shared→user projection the settings tree renders, so j/k walks
        // the list in VISUAL order regardless of transport ordering. Rows are
        // COPIES, not names: a shadowed name appears once per scope.
        const rows = [
            ...pkgs.list.filter((p) => p.scope === "shared"),
            ...pkgs.list.filter((p) => p.scope !== "shared"),
        ];
        const keyOf = (row) => `${row.name}\u0001${row.scope ?? ""}\u0001${row.owner?.subject ?? ""}`;
        const selectedKey = pkgs.selectedName
            ? `${pkgs.selectedName}\u0001${pkgs.selectedSelector?.scope ?? ""}\u0001${pkgs.selectedSelector?.owner?.subject ?? ""}`
            : null;
        let index = rows.findIndex((row) => keyOf(row) === selectedKey);
        if (index < 0) index = rows.findIndex((row) => row.name === pkgs.selectedName);
        const next = rows[Math.min(rows.length - 1, Math.max(0, (index < 0 ? (delta > 0 ? -1 : 0) : index) + delta))];
        if (next && (next.name !== pkgs.selectedName || keyOf(next) !== selectedKey)) {
            await this.selectAdminPackage(next.name, packageRowSelector(next));
        }
    }

    toggleAdminPackageDir(dir) {
        this.dispatch({ type: "admin/packages/toggleDir", dir });
    }

    async selectAdminPackageFile(filePath) {
        const pkgs = this.getState().admin?.packages;
        const name = pkgs?.selectedName;
        if (!name || !filePath) return;
        // Tag the preview with the current selection token so a slow file for
        // one copy can't render under another copy of the same name (their
        // file paths are identical — both ship plugin.json).
        const seq = pkgs?.selectionSeq ?? 0;
        const selector = pkgs?.selectedSelector ?? null;
        this.dispatch({ type: "admin/packages/file/loading", path: filePath });
        try {
            const file = await this.transport.getAgentPackageFile(name, null, filePath, selector);
            this.dispatch({ type: "admin/packages/file/loaded", seq, file });
        } catch (error) {
            this.dispatch({ type: "admin/packages/file/loadFailed", seq, path: filePath, error: error?.message || String(error) });
        }
    }

    /**
     * One entry point for package mutations so pending/error state stays
     * uniform: kind = promote | demote | pin | enable | disable | delete.
     * (No "sync": packages are imported client-side and published as
     * artifacts — re-import from the link to update.)
     */
    async runAdminPackageAction(kind, arg = null) {
        const pkgs = this.getState().admin?.packages;
        const name = pkgs?.selectedName;
        const selector = pkgs?.selectedSelector ?? null;
        if (!name) return;
        this.dispatch({ type: "admin/packages/action/pending", action: kind });
        try {
            switch (kind) {
                case "promote":
                    await this.transport.setAgentPackageScope(name, "shared", selector);
                    break;
                case "demote":
                    await this.transport.setAgentPackageScope(name, "user", selector);
                    break;
                // Publish the selected copy's version (arg, default active)
                // into the same-named package in the OTHER scope. THE update
                // path when the shared name already exists — promote can only
                // move a row to an unused name.
                case "republish":
                    await this.transport.republishAgentPackageVersion(
                        name, arg, selector?.scope === "shared" ? "user" : "shared",
                        selector,
                    );
                    break;
                case "pin":
                    await this.transport.pinAgentPackageVersion(name, arg, selector);
                    break;
                case "enable":
                case "disable":
                    await this.transport.setAgentPackageEnabled(name, kind === "enable", selector);
                    break;
                case "delete":
                    await this.transport.deleteAgentPackage(name, selector);
                    break;
                // Editors live on the shared copy only — no selector.
                case "grantEditor":
                    await this.transport.grantAgentPackageEditor(name, arg);
                    break;
                case "revokeEditor":
                    await this.transport.revokeAgentPackageEditor(name, arg);
                    break;
                default:
                    throw new Error(`unknown package action: ${kind}`);
            }
            this.dispatch({ type: "admin/packages/action/done" });
            await this.refreshAdminAgentPackages();
            // Re-select the copy that still exists. promote/demote MOVE the row
            // to the other scope, so the pre-action selector now points at a
            // copy that is gone — re-selecting it would error the pane with
            // "package not found". Every other action leaves the copy in place.
            if (kind !== "delete") {
                const nextSelector = kind === "promote"
                    ? { scope: "shared", ...(selector?.owner ? { owner: selector.owner } : {}) }
                    : kind === "demote"
                        ? { scope: "user", ...(selector?.owner ? { owner: selector.owner } : {}) }
                        : selector;
                await this.selectAdminPackage(name, nextSelector);
            }
        } catch (error) {
            this.dispatch({ type: "admin/packages/action/failed", error: error?.message || String(error) });
        }
    }

    /** Surface an add-dialog problem (used by the web layer's read phase). */
    failAdminAddPackage(message) {
        this.dispatch({ type: "admin/packages/addDialog/failed", error: message });
    }

    /** Publish an uploaded folder ([{path, contentBase64}]) as a package. */
    async submitAdminUploadPackage(files, scope) {
        const dialog = this.getState().admin?.packages?.addDialog;
        if (!dialog?.open || dialog.submitting) return;
        if (typeof this.transport.uploadAgentPackage !== "function") {
            this.dispatch({ type: "admin/packages/addDialog/failed", error: "Folder upload is not available on this deployment." });
            return;
        }
        this.dispatch({ type: "admin/packages/addDialog/submitting" });
        try {
            const outcome = await this.transport.uploadAgentPackage(files, scope === "shared" ? "shared" : "user");
            this.dispatch({ type: "admin/packages/addDialog/close" });
            await this.refreshAdminAgentPackages();
            if (outcome?.name) await this.selectAdminPackage(outcome.name);
        } catch (error) {
            const validation = Array.isArray(error?.validation?.errors)
                ? `\n${error.validation.errors.map((e) => `[${e.code}] ${e.message}`).join("\n")}`
                : "";
            this.dispatch({ type: "admin/packages/addDialog/failed", error: `${error?.message || error}${validation}` });
        }
    }

    openAdminAddPackage() {
        this.dispatch({ type: "admin/packages/addDialog/open" });
    }

    /**
     * Publish a new version of an existing package. Same dialog, same import
     * path — the only difference is that the destination is already chosen, so
     * the scope is inherited and the manifest name is checked on submit.
     */
    openAdminUpdatePackage(name, scope = "user") {
        const packageName = String(name || "").trim();
        if (!packageName) return;
        this.dispatch({ type: "admin/packages/addDialog/open", updateName: packageName, scope });
    }

    closeAdminAddPackage() {
        this.dispatch({ type: "admin/packages/addDialog/close" });
    }

    setAdminAddPackageField(field, value) {
        this.dispatch({ type: "admin/packages/addDialog/setField", field, value });
    }

    /**
     * Import a package from a pasted repo link — IN THIS BROWSER, as the
     * signed-in user — and publish it through the standard upload path.
     * Nothing about the repo is stored server-side: no source row, no token.
     * A pasted PAT is used for this import only and never leaves the tab.
     */
    async submitAdminAddPackage() {
        const dialog = this.getState().admin?.packages?.addDialog;
        if (!dialog?.open || dialog.submitting) return;
        if (typeof this.transport.uploadAgentPackage !== "function") {
            this.dispatch({ type: "admin/packages/addDialog/failed", error: "Package upload is not available on this deployment." });
            return;
        }
        const link = String(dialog.repoUrl || "").trim();
        const parsed = parseAgentSourceLink(link);
        if (parsed.error) {
            this.dispatch({ type: "admin/packages/addDialog/failed", error: parsed.error });
            return;
        }
        this.dispatch({ type: "admin/packages/addDialog/submitting" });
        try {
            const pat = String(dialog.authToken || "").trim();
            let token = pat || null;
            let tokenKind = "pat";
            if (!token && parsed.kind === "ado") {
                // No PAT: read the repo with the viewer's own Entra token.
                this.dispatch({ type: "admin/packages/addDialog/progress", message: "getting an Azure DevOps token for your account…" });
                token = typeof this.transport.getRepoAccessToken === "function"
                    ? await this.transport.getRepoAccessToken("ado")
                    : null;
                tokenKind = "bearer";
            }
            const { files } = await importPackageFilesFromLink(link, {
                token,
                tokenKind,
                onProgress: (message) => this.dispatch({ type: "admin/packages/addDialog/progress", message }),
            });
            // Updating names its target up front, and a package's identity is
            // its manifest name — so a folder that builds a DIFFERENT package
            // would quietly create a second one instead of updating this. Say
            // so rather than publishing the surprise.
            if (dialog.updateName) {
                const manifestName = readImportedPackageName(files);
                if (manifestName && manifestName !== dialog.updateName) {
                    this.dispatch({
                        type: "admin/packages/addDialog/failed",
                        error: `That folder builds "${manifestName}", not "${dialog.updateName}". `
                            + "Use Add package to publish it as its own package.",
                    });
                    return;
                }
            }
            this.dispatch({ type: "admin/packages/addDialog/progress", message: `publishing ${files.length} file(s)…` });
            const outcome = await this.transport.uploadAgentPackage(files, dialog.scope === "shared" ? "shared" : "user");
            this.dispatch({ type: "admin/packages/addDialog/close" });
            await this.refreshAdminAgentPackages();
            if (outcome?.name) await this.selectAdminPackage(outcome.name);
        } catch (error) {
            const validation = Array.isArray(error?.validation?.errors)
                ? `\n${error.validation.errors.map((issue) => `[${issue.code}] ${issue.message}`).join("\n")}`
                : "";
            this.dispatch({ type: "admin/packages/addDialog/failed", error: `${error?.message || error}${validation}` });
        }
    }

    beginAdminEditGhcpKey() {
        this.dispatch({ type: "admin/ghcpKey/beginEdit", draft: "" });
    }

    setAdminGhcpKeyDraft(draft, cursorIndex = String(draft || "").length) {
        this.dispatch({ type: "admin/ghcpKey/setDraft", draft, cursorIndex });
    }

    insertAdminGhcpKeyText(text) {
        const ghcp = this.getState().admin?.ghcpKey;
        if (!ghcp?.editing) return;
        // GitHub Copilot keys are single-line opaque tokens — strip
        // newlines so accidental paste of a multi-line clipboard still
        // produces a usable key.
        const sanitized = String(text || "").replace(/\r?\n/g, "");
        const next = insertPromptTextAtCursor(ghcp.draft || "", ghcp.cursorIndex || 0, sanitized);
        this.setAdminGhcpKeyDraft(next.prompt, next.cursor);
    }

    deleteAdminGhcpKeyChar() {
        const ghcp = this.getState().admin?.ghcpKey;
        if (!ghcp?.editing) return;
        const next = deletePromptCharBackward(ghcp.draft || "", ghcp.cursorIndex || 0);
        this.setAdminGhcpKeyDraft(next.prompt, next.cursor);
    }

    moveAdminGhcpKeyCursor(delta) {
        const ghcp = this.getState().admin?.ghcpKey;
        if (!ghcp?.editing) return;
        const draft = ghcp.draft || "";
        this.setAdminGhcpKeyDraft(draft, clampPromptCursor(draft, (ghcp.cursorIndex || 0) + delta));
    }

    moveAdminGhcpKeyCursorToBoundary(kind) {
        const ghcp = this.getState().admin?.ghcpKey;
        if (!ghcp?.editing) return;
        const draft = ghcp.draft || "";
        this.setAdminGhcpKeyDraft(draft, kind === "start" ? 0 : draft.length);
    }

    cancelAdminEditGhcpKey() {
        this.dispatch({ type: "admin/ghcpKey/cancelEdit" });
    }

    /**
     * Save the current draft as the per-user GitHub Copilot key. Empty
     * or whitespace-only drafts are rejected so users cannot
     * accidentally clear their key by hitting Enter on a blank field —
     * use `clearAdminGhcpKey()` for that.
     */
    async saveAdminGhcpKey() {
        const storeAsSystem = Boolean(this.getState().admin.ghcpKey.storeAsSystem);
        const setter = storeAsSystem ? "setSystemGitHubCopilotKey" : "setCurrentUserGitHubCopilotKey";
        if (typeof this.transport[setter] !== "function") {
            this.dispatch({ type: "admin/ghcpKey/saveFailed", error: storeAsSystem
                ? "This deployment does not support System keys yet."
                : "Admin Console is not available on this transport." });
            return;
        }
        const draft = String(this.getState().admin.ghcpKey.draft || "").trim();
        if (draft.length === 0) {
            this.dispatch({ type: "admin/ghcpKey/saveFailed", error: "Enter a key, or use Clear to remove the override." });
            return;
        }
        this.dispatch({ type: "admin/ghcpKey/saving" });
        try {
            if (storeAsSystem) {
                const status = await this.transport.setSystemGitHubCopilotKey({ key: draft });
                this.dispatch({ type: "admin/systemGhcpKey/saved", status });
            } else {
                const profile = await this.transport.setCurrentUserGitHubCopilotKey({ key: draft });
                this.dispatch({ type: "admin/ghcpKey/saved", profile });
            }
        } catch (error) {
            this.dispatch({ type: "admin/ghcpKey/saveFailed", error: error?.message || String(error) });
        }
    }

    /**
     * Clear the per-user GitHub Copilot key, reverting the user to the
     * worker's env-supplied default token.
     */
    async clearAdminGhcpKey() {
        const storeAsSystem = Boolean(this.getState().admin.ghcpKey.storeAsSystem);
        const setter = storeAsSystem ? "setSystemGitHubCopilotKey" : "setCurrentUserGitHubCopilotKey";
        if (typeof this.transport[setter] !== "function") {
            this.dispatch({ type: "admin/ghcpKey/saveFailed", error: storeAsSystem
                ? "This deployment does not support System keys yet."
                : "Admin Console is not available on this transport." });
            return;
        }
        this.dispatch({ type: "admin/ghcpKey/saving" });
        try {
            if (storeAsSystem) {
                const status = await this.transport.setSystemGitHubCopilotKey({ key: null });
                this.dispatch({ type: "admin/systemGhcpKey/saved", status });
            } else {
                const profile = await this.transport.setCurrentUserGitHubCopilotKey({ key: null });
                this.dispatch({ type: "admin/ghcpKey/saved", profile });
            }
        } catch (error) {
            this.dispatch({ type: "admin/ghcpKey/saveFailed", error: error?.message || String(error) });
        }
    }

    // ─── Providers & Budgets (the coin button) ─────────────────
    //
    // docs/proposals/providers-and-budgets-meters.md is the build spec: one
    // table over one read, plus the day-by-day chart under the row someone
    // selected. Nothing here asks whether the viewer may do a thing. Every
    // call carries the signed-in person down to the `cms_provider_*`
    // procedures, the DATABASE refuses what they may not do, and it writes the
    // refusal in words meant for them — which are passed straight through,
    // because they name the remedy and nothing this file could invent would.

    /**
     * Open the surface and load it.
     *
     * `provider` lets one call land on the provider that stopped something —
     * the paused line's link, where the sentence is above the table and the
     * row it names is in it.
     */
    async openBudget({ provider = undefined } = {}) {
        this.dispatch({
            type: "ui/budgetOpen",
            open: true,
            ...(provider === undefined ? {} : { provider }),
        });
        await this.loadProviderTable();
        // A provider opened AT a name shows that name's chart straight away.
        const opened = this.getState().budget || {};
        if (opened.selectedProvider) {
            await Promise.all([
                this.loadProviderSeries(opened.selectedProvider, opened.selectedScope || "*"),
                this.loadProviderSystemUsage(opened.selectedProvider, opened.selectedScope || "*"),
            ]);
        }
    }

    /** Close the surface and return to the standard workspace. */
    closeBudget() {
        this.dispatch({ type: "ui/budgetOpen", open: false });
    }

    /**
     * The "show overall usage" tick.
     *
     * Both pairs of numbers are already in the grid, so this changes what the
     * cells print and costs no request. Omit `overall` to flip it.
     */
    setBudgetOverall(overall) {
        const before = this.getState().budget?.overall === true;
        this.dispatch({ type: "budget/overall", ...(typeof overall === "boolean" ? { overall } : {}) });
        const budget = this.getState().budget || {};
        // The cells already hold both pairs, so the TABLE costs no request.
        // The chart does: its bars are one scope or the other, and leaving
        // the old ones up relabels one person's spend as everyone's.
        if (budget.overall === before || !budget.selectedProvider) return undefined;
        return this.loadProviderSeries(budget.selectedProvider, budget.selectedScope || "*");
    }

    async setBudgetRangeDays(days) {
        const rangeDays = Number(days);
        if (!BUDGET_SERIES_RANGES.includes(rangeDays)) return;
        const before = this.getState().budget?.rangeDays ?? BUDGET_SERIES_DAYS;
        this.dispatch({ type: "budget/rangeDays", rangeDays });
        const budget = this.getState().budget || {};
        if (rangeDays === before || !budget.selectedProvider) return;
        await Promise.all([
            this.loadProviderSeries(budget.selectedProvider, budget.selectedScope || "*"),
            this.loadProviderSystemUsage(budget.selectedProvider, budget.selectedScope || "*"),
        ]);
    }

    /**
     * Select a row: a provider, or one of its per-model limits.
     *
     * `scope` is '*' for the provider itself, or a qualified model reference
     * for a model row — and the chart follows it, so standing on a model row
     * shows that model's days rather than the whole provider's. Selecting the
     * row you are already on clears it: a provider collapses, a model row
     * falls back to the provider above it.
     *
     * The model rows are already in state — expanding shows rows the table
     * has. Only the chart is a read.
     */
    async selectBudgetProvider(provider, scope = "*") {
        this.dispatch({ type: "budget/selectProvider", provider, scope });
        const budget = this.getState().budget || {};
        if (!budget.selectedProvider) return;
        await Promise.all([
            this.loadProviderSeries(budget.selectedProvider, budget.selectedScope || "*"),
            this.loadProviderSystemUsage(budget.selectedProvider, budget.selectedScope || "*"),
        ]);
    }

    /**
     * The table: every provider in the viewer's namespace with its used and
     * quota figures for all three periods, plus what is waiting.
     *
     * Two reads, not five. The grid is one call by design — the numbers in a
     * row and the numbers in the row under it come from the same statement, so
     * they cannot be a refresh apart. The paused list is separate because it
     * also feeds the session rows, which say why a session stopped whether or
     * not this surface is open.
     *
     * A read that FAILS is recorded as a failure, never as empty data. The two
     * look identical on screen if you let them — "this provider has no limits"
     * and "we could not find out what its limits are" — and only one of them
     * is safe to act on. Whatever was already on screen stays there
     * underneath, marked old, rather than being blanked.
     */
    async loadProviderTable() {
        if (!this._budgetReadable()) return;
        this.dispatch({ type: "budget/loading" });
        const [grid, paused] = await Promise.all([
            this._readBudgetPart(() => this.transport.getProviderUsageGrid()),
            this._readBudgetPart(() => this.transport.listPausedSessions()),
        ]);
        this._settleBudgetRead([
            ["grid", "the provider table", grid, (v) => v?.rows || []],
            ["paused", "the paused sessions", paused, (v) => v?.sessions || []],
        ]);
    }

    /**
     * The day-by-day chart under one provider.
     *
     * Kept apart from the table's read so a failed chart never blanks the
     * numbers above it, and so selecting a row does not re-read every
     * provider's meters.
     */
    /**
     * Re-read the table AND the chart under it.
     *
     * They are two requests, and re-reading only the first left the chart
     * saying "No token usage" beside a row reporting usage — which is the
     * no-data-versus-not-looked-again confusion this screen exists to
     * prevent. Both the Refresh button and the background poll come here.
     */
    async refreshProviderTable() {
        await this.loadProviderTable();
        const budget = this.getState().budget || {};
        if (budget.selectedProvider) {
            await Promise.all([
                this.loadProviderSeries(budget.selectedProvider, budget.selectedScope || "*"),
                this.loadProviderSystemUsage(budget.selectedProvider, budget.selectedScope || "*"),
            ]);
        }
    }

    async loadProviderSeries(provider, scope = "*") {
        const name = String(provider ?? "").trim();
        if (!name || typeof this.transport.getProviderUsage !== "function") return;
        // '*' means the whole provider. Anything else is one model, and the
        // report is filtered to it — the same filter the model row's own
        // numbers came from, so the chart and the row agree.
        const model = scope && scope !== "*" ? scope : null;
        // The chart must be drawn from the SAME slice of spend as the row
        // above it, or the two contradict each other under one heading. Two
        // filters do that, and both were missing:
        //
        //   chargeClass "user" — the meters a cell reads are never moved for
        //   system spend, so a chart that summed every class drew a provider
        //   as over its limit while the cell said 15%.
        //
        //   mine — with the tick off a cell holds YOUR spend against YOUR
        //   share, so an unfiltered chart put the whole fleet's bars under a
        //   heading that said "your usage", above a line that was your
        //   personal share of the limit.
        const overall = this.getState().budget?.overall === true;
        const rangeDays = this.getState().budget?.rangeDays ?? BUDGET_SERIES_DAYS;
        this.dispatch({ type: "budget/series/loading", provider: name, scope, rangeDays });
        try {
            const report = await this.transport.getProviderUsage({
            days: rangeDays,
                provider: name,
                ...(model ? { model } : {}),
                chargeClass: "user",
                ...(overall ? {} : { mine: true }),
                dimension: "provider",
            });
            this.dispatch({
                type: "budget/series/loaded",
                provider: name,
                scope,
                rangeDays,
                days: Array.isArray(report?.daily) ? report.daily : [],
            });
        } catch (error) {
            this.dispatch({
                type: "budget/series/failed",
                provider: name, scope, rangeDays, error: budgetRefusalMessage(error),
            });
        }
    }

    /** Admin-only machinery spend, kept separate from user limits. */
    async loadProviderSystemUsage(provider, scope = "*") {
        const role = this.getState().auth?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous"
            || this.getState().admin?.profile?.isAdmin === true;
        const name = String(provider ?? "").trim();
        if (!isAdmin || !name || typeof this.transport.getProviderUsage !== "function") return;
        const model = scope && scope !== "*" ? scope : null;
        const rangeDays = this.getState().budget?.rangeDays ?? BUDGET_SERIES_DAYS;
        this.dispatch({ type: "budget/systemUsage/loading", provider: name, scope, rangeDays });
        try {
            const report = await this.transport.getProviderUsage({
            days: rangeDays,
                provider: name,
                ...(model ? { model } : {}),
                chargeClass: "system",
                dimension: "model",
                limit: 100,
            });
            this.dispatch({ type: "budget/systemUsage/loaded", provider: name, scope, rangeDays, report });
        } catch (error) {
            this.dispatch({
                type: "budget/systemUsage/failed",
                provider: name, scope, rangeDays, error: budgetRefusalMessage(error),
            });
        }
    }

    /**
     * Why the waiting sessions are waiting, for the session list.
     *
     * The catalog row carries a status of "waiting" and nothing else; the
     * reason is published by `listPausedSessions`, and the session list joins
     * the two (see budgetPauseForSession). So take them while a wait is on
     * screen — once a minute, and never while the Budget surface is open,
     * which runs its own refresh on the same cadence.
     *
     * A failure is no news: the reasons already on screen stay as they are.
     */
    async refreshBudgetPausesIfStale(sessions) {
        if (typeof this.transport.listPausedSessions !== "function") return;
        const state = this.getState();
        if (state.ui?.budgetOpen) return;
        // A scheduled session is "waiting" on its own clock, not on a budget,
        // and on a busy fleet those are most of the waits. Skipping them keeps
        // this from becoming a permanent background poll on a portal where
        // nothing is actually stopped.
        const waiting = (Array.isArray(sessions) ? sessions : [])
            .some((row) => row && !row.isGroup && row.status === "waiting" && row.cronActive !== true);
        // Nothing is waiting, and there is nothing on screen left to clear.
        if (!waiting && (state.budget?.paused || []).length === 0) return;
        const now = Date.now();
        if (now - (this.budgetPauseReadAt || 0) < 60_000) return;
        this.budgetPauseReadAt = now;
        await this.refreshPausedSessions({ quiet: true }).catch(() => {});
    }

    /**
     * The paused list alone. One call, because the session rows need the
     * reasons whether or not the table is on screen.
     *
     * `quiet` is for the background poll: a minute-by-minute read that nobody
     * asked for must not put an error banner on a table the reader is not even
     * looking at. The reasons already on screen stay as they are, and the next
     * poll tries again.
     */
    async refreshPausedSessions({ quiet = false } = {}) {
        if (typeof this.transport.listPausedSessions !== "function") {
            if (quiet) return;
            this.dispatch({
                type: "budget/loadFailed",
                error: "Providers and budgets are not available on this deployment.",
            });
            return;
        }
        const paused = await this._readBudgetPart(() => this.transport.listPausedSessions());
        if (paused.error && quiet) return;
        this._settleBudgetRead([
            ["paused", "the paused sessions", paused, (v) => v?.sessions || []],
        ]);
    }

    /** An older server has none of these routes. Say so; do not draw zeros. */
    _budgetReadable() {
        if (typeof this.transport.getProviderUsageGrid === "function") return true;
        this.dispatch({
            type: "budget/loadFailed",
            error: "Providers and budgets are not available on this deployment.",
        });
        return false;
    }

    /** One read, kept apart from its siblings so one failure cannot take them all. */
    async _readBudgetPart(run) {
        try {
            return { value: await run(), error: null };
        } catch (error) {
            return { value: null, error: budgetRefusalMessage(error) };
        }
    }

    /**
     * Turn the reads into state.
     *
     * Whatever came back is written; whatever failed is named. A partial
     * failure is worth the two dispatches: the parts that arrived are worth
     * having, and the part that did not arrive has to say so rather than
     * showing the last numbers as if they were current.
     */
    _settleBudgetRead(parts) {
        const loaded = {};
        const failures = [];
        for (const [key, label, read, pick] of parts) {
            if (read.error) failures.push({ label, error: read.error });
            else loaded[key] = pick(read.value);
        }
        if (Object.keys(loaded).length === 0) {
            // Everything failed, which nearly always means one cause — signed
            // out, server down. Two copies of one sentence is not two facts,
            // so the server's own words go up once.
            this.dispatch({ type: "budget/loadFailed", error: failures[0]?.error || "The read failed." });
            return;
        }
        this.dispatch({ type: "budget/loaded", ...loaded });
        if (failures.length === 0) return;
        const message = failures.map((f) => `${f.label} could not be read: ${f.error}`).join(" ");
        // WHICH half failed decides what is marked. `budget/loadFailed` sets
        // the TABLE's error, and firing it when the paused list alone failed
        // put a red "these numbers are from an earlier read" over numbers
        // that had just been read successfully — while the genuinely old
        // waiting line underneath carried no mark at all. Exactly backwards.
        const gridFailed = parts.some(([key, , read]) => key === "grid" && read.error);
        this.dispatch(gridFailed
            ? { type: "budget/loadFailed", error: message }
            : { type: "budget/pausedFailed", error: message });
    }

    /**
     * Every change to a provider, in one shape: run it, re-read the table, and
     * hand the caller back what happened.
     *
     * Nothing throws. A sheet gets `{ok, error, code, result}` and renders the
     * refusal where the person is looking; the same message also goes to the
     * status line for anyone who has already closed the sheet.
     */
    async _runBudgetChange(run) {
        try {
            const result = await run();
            await this.loadProviderTable();
            const after = this.getState().budget || {};
            // A limit that changed moves the chart's dashed line, so the chart
            // is re-read with the table rather than left describing the old one.
            if (after.selectedProvider) {
                await this.loadProviderSeries(after.selectedProvider, after.selectedScope || "*");
            }
            return { ok: true, error: null, code: null, result: result ?? null };
        } catch (error) {
            const message = budgetRefusalMessage(error);
            this.dispatch({ type: "ui/status", text: message });
            // A refusal is often the world having moved — the provider was
            // already deleted, the limit already gone. Re-reading here is
            // what stops the table keeping a row the server says is not
            // there, with a chart under it saying "no usage".
            await this.loadProviderTable().catch(() => {});
            return { ok: false, error: message, code: error?.code || null, result: null };
        }
    }

    /** A change this deployment cannot make at all, reported like any other refusal. */
    _refuseBudgetChange(message) {
        this.dispatch({ type: "ui/status", text: message });
        return { ok: false, error: message, code: "UNSUPPORTED", result: null };
    }

    /**
     * Create a provider. `shared` makes one anyone may spend from (admins
     * only); otherwise it is the caller's own, on their own credentials, and
     * nobody else sees it. The name is permanent — sessions refer to it.
     */
    async createProvider({ name, type, credentials, baseUrl = null, shared = false } = {}) {
        const op = shared ? "createProvider" : "createMyProvider";
        if (typeof this.transport[op] !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport[op]({ name, type, credentials, baseUrl }));
    }

    /**
     * Delete a provider. Which door it goes through follows the provider's
     * own class, read from the table already on screen: a shared provider is
     * an admin's to remove, a personal one is its owner's. The result carries
     * `waitingSessions` — how many sessions now wait on a name that no longer
     * resolves — which the sheet says out loud before it is confirmed.
     */
    async deleteProvider(name, { shared = null } = {}) {
        const known = (this.getState().budget?.grid || [])
            .find((row) => row?.providerName === name && row?.rowKind !== "model");
        const isShared = shared === null ? known?.class === "shared" : shared === true;
        const op = isShared ? "deleteProvider" : "deleteMyProvider";
        if (typeof this.transport[op] !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport[op](name));
    }

    /**
     * Save one limit. The same (period, scope) replaces what was there, and
     * the limit counts from what the period has ALREADY spent — it never
     * resets anything. The result's `seededTokens` is that already-counted
     * number, which the editor uses to warn that saving pauses sessions now.
     */
    async setProviderLimit({ provider, period, model = null, tokens } = {}) {
        if (typeof this.transport.setProviderLimit !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.setProviderLimit({ name: provider, period, model, tokens }));
    }

    /** Drop one limit. Removing one only ever grants room; usage history is kept. */
    async removeProviderLimit({ provider, period, model = null } = {}) {
        if (typeof this.transport.removeProviderLimit !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.removeProviderLimit({ name: provider, period, model }));
    }

    /**
     * The share of each of a shared provider's limits one person may use.
     * 100 means no per-person ceiling. It is derived live from the limit as
     * it stands, so there is nothing to re-stamp when a limit changes.
     */
    async setProviderAllowance({ provider, pct } = {}) {
        if (typeof this.transport.setProviderAllowance !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.setProviderAllowance({ name: provider, pct }));
    }

    /**
     * Place or release a hold. A hold stops new turns against a provider
     * until it is released, independently of every limit. With neither an end
     * time nor `release` it has no end.
     */
    async setProviderHold({ provider, untilUtc = null, release = false } = {}) {
        if (typeof this.transport.setProviderHold !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.setProviderHold({ name: provider, untilUtc, release }));
    }

    /**
     * The cluster default tuple: what system sessions run, and what anyone
     * who set no default of their own gets. It must name a SHARED provider,
     * and the model half must belong to it — the database refuses anything
     * else, in words.
     */
    async setClusterDefault(tuple) {
        if (typeof this.transport.setClusterDefault !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.setClusterDefault(tuple));
    }

    /** The caller's own prefill for new sessions. A null tuple clears it. */
    async setMyDefault(tuple) {
        if (typeof this.transport.setMyDefault !== "function") {
            return this._refuseBudgetChange("Providers and budgets are not available on this deployment.");
        }
        return this._runBudgetChange(() => this.transport.setMyDefault(tuple));
    }
    async ensureExecutionHistory(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.getExecutionHistory !== "function") return null;
        const current = this.getState().executionHistory?.bySessionId?.[sessionId] || null;
        const now = Date.now();
        if (!force && current?.loading) return current;
        if (!force && current && Number.isFinite(current.fetchedAt) && (now - current.fetchedAt) < 15_000) {
            return current;
        }
        this.dispatch({ type: "executionHistory/loading", sessionId });
        try {
            const events = await this.transport.getExecutionHistory(sessionId);
            this.dispatch({
                type: "executionHistory/loaded",
                sessionId,
                events: events || [],
                fetchedAt: Date.now(),
            });
        } catch (error) {
            console.error("[executionHistory] fetch error:", error?.message || error);
            this.dispatch({
                type: "executionHistory/error",
                sessionId,
                error: error?.message || String(error),
                fetchedAt: Date.now(),
            });
        }
        return this.getState().executionHistory?.bySessionId?.[sessionId] || null;
    }

    async ensureFilesForScope(scope = selectFilesScope(this.getState()), { force = false } = {}) {
        const sessionIds = selectFileSessionIdsForScope(this.getState(), scope);
        if (sessionIds.length === 0) {
            return scope === "allSessions" ? [] : null;
        }
        if (scope === "allSessions" || sessionIds.length > 1) {
            return Promise.allSettled(sessionIds.map((sessionId) => this.ensureFilesForSession(sessionId, { force })));
        }
        return this.ensureFilesForSession(sessionIds[0], { force });
    }

    async ensureSelectedFilePreview() {
        const selectedItem = selectSelectedFileBrowserItem(this.getState());
        if (!selectedItem?.sessionId || !selectedItem?.filename) return null;
        return this.ensureFilePreview(selectedItem.sessionId, selectedItem.filename).catch(() => null);
    }

    async ensureFilesForSession(sessionId, { force = false } = {}) {
        if (!sessionId || typeof this.transport.listArtifacts !== "function") return null;

        const current = this.getState().files.bySessionId[sessionId];
        if (!force && current?.loading) return current;
        // A short TTL rather than force-on-every-call. Forcing unconditionally
        // made the periodic inspector refresh refetch every cycle, which
        // re-rendered the list and made it visibly flicker. Caching forever was
        // the original bug. Ten seconds keeps a live agent's new artifacts
        // appearing on their own without hammering the API.
        const age = Date.now() - (Number(current?.fetchedAt) || 0);
        if (!force && current?.loaded && age < FILES_LIST_TTL_MS) {
            if (current.selectedFilename) {
                await this.ensureFilePreview(sessionId, current.selectedFilename).catch(() => {});
            }
            return current;
        }

        this.dispatch({ type: "files/sessionLoading", sessionId });
        try {
            const entries = await this.transport.listArtifacts(sessionId);
            const fetchedAt = Date.now();
            this.dispatch({
                type: "files/sessionLoaded",
                sessionId,
                entries,
                fetchedAt,
            });
            const nextState = this.getState().files.bySessionId[sessionId];
            if (nextState?.selectedFilename) {
                await this.ensureFilePreview(sessionId, nextState.selectedFilename).catch(() => {});
            }
            return nextState;
        } catch (error) {
            this.dispatch({
                type: "files/sessionError",
                sessionId,
                error: error?.message || String(error),
            });
            return null;
        }
    }

    async ensureFilePreview(sessionId, filename, { force = false } = {}) {
        if (!sessionId || !filename || typeof this.transport.downloadArtifact !== "function") return null;

        const current = this.getState().files.bySessionId[sessionId];
        const preview = current?.previews?.[filename];
        let entry = findArtifactEntry(current?.entries, filename);
        if (!force && preview?.loading) return preview;
        if (!force && preview && (preview.content !== undefined || preview.error)) {
            return preview;
        }

        if (!entry && typeof this.transport.getArtifactMetadata === "function") {
            try {
                entry = await this.transport.getArtifactMetadata(sessionId, filename);
            } catch {
                entry = null;
            }
        }

        this.dispatch({ type: "files/previewLoading", sessionId, filename });
        try {
            const previewPayload = entry?.isBinary === true
                ? normalizePreviewPayload(filename, "", entry.contentType || "", entry)
                : normalizePreviewPayload(
                    filename,
                    await this.transport.downloadArtifact(sessionId, filename),
                    entry?.contentType || "",
                    entry,
                );
            this.dispatch({
                type: "files/previewLoaded",
                sessionId,
                filename,
                ...previewPayload,
            });
            return previewPayload;
        } catch (error) {
            this.dispatch({
                type: "files/previewError",
                sessionId,
                filename,
                error: error?.message || String(error),
            });
            return null;
        }
    }

    buildArtifactPickerItems(artifactLinks = [], httpLinks = []) {
        const items = (artifactLinks || []).map((link) => ({
            id: `${link.sessionId}/${link.filename}`,
            kind: "artifact",
            sessionId: link.sessionId,
            filename: link.filename,
        }));

        for (const link of httpLinks || []) {
            const href = String(link?.href || "").trim();
            if (!href) continue;
            items.push({
                id: `url:${href}`,
                kind: "url",
                href,
                text: String(link?.text || href).trim() || href,
            });
        }

        if ((artifactLinks || []).length > 1) {
            items.push({
                id: "__downloadAll__",
                kind: "downloadAll",
            });
        }

        return items;
    }

    buildArtifactPickerModal({ artifactLinks, httpLinks, previousFocus, selectedId } = {}) {
        const items = this.buildArtifactPickerItems(artifactLinks, httpLinks);
        if (items.length === 0) return null;
        const selectedIndex = items.findIndex((item) => item.id === selectedId);

        return {
            type: "artifactPicker",
            title: "Linked Items",
            previousFocus,
            artifactLinks,
            httpLinks,
            items,
            selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
            exportDirectory: typeof this.transport.getArtifactExportDirectory === "function"
                ? this.transport.getArtifactExportDirectory()
                : null,
        };
    }

    getArtifactPickerSelectionId() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return null;
        return modal.items?.[modal.selectedIndex || 0]?.id || null;
    }

    replaceArtifactPickerModal(selectedId = null) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return;

        const nextModal = this.buildArtifactPickerModal({
            artifactLinks: modal.artifactLinks || [],
            httpLinks: modal.httpLinks || [],
            previousFocus: modal.previousFocus,
            selectedId: selectedId || this.getArtifactPickerSelectionId(),
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/modal", modal: null });
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        this.dispatch({ type: "ui/modal", modal: nextModal });
    }

    async saveArtifactDownload(sessionId, filename) {
        if (typeof this.transport.saveArtifactDownload !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact download is not supported by this transport" });
            return null;
        }

        try {
            const download = await this.transport.saveArtifactDownload(sessionId, filename);
            this.dispatch({
                type: "files/downloaded",
                sessionId,
                filename,
                localPath: download?.localPath || "",
                downloadedAt: Date.now(),
            });
            const activeSessionId = this.getState().sessions.activeSessionId;
            const shouldRefreshFiles = sessionId === activeSessionId || this.getState().ui.inspectorTab === "files";
            if (shouldRefreshFiles) {
                await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
                if (sessionId === activeSessionId) {
                    this.dispatch({
                        type: "files/select",
                        sessionId,
                        filename,
                    });
                    if (this.getState().ui.inspectorTab === "files") {
                        await this.ensureFilePreview(sessionId, filename, { force: true }).catch(() => null);
                    }
                }
            }
            return download;
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Download failed: ${error?.message || String(error)}`,
            });
            return null;
        }
    }

    async openSelectedFileInDefaultApp() {
        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({
                type: "ui/status",
                text: state.sessions.activeSessionId || selectFilesScope(state) === "allSessions"
                    ? "No file selected"
                    : "No session selected",
            });
            return;
        }
        const { sessionId, filename: selectedFilename } = selectedItem;
        const scope = selectFilesScope(state);
        if (typeof this.transport.openPathInDefaultApp !== "function") {
            this.dispatch({ type: "ui/status", text: "Opening files in the default app is not supported by this transport" });
            return;
        }

        let localPath = state.files.bySessionId[sessionId]?.downloads?.[selectedFilename]?.localPath || null;
        if (!localPath) {
            this.dispatch({
                type: "ui/status",
                text: `Downloading ${selectedFilename} to open it...`,
            });
            const download = await this.saveArtifactDownload(sessionId, selectedFilename);
            localPath = download?.localPath || null;
        }

        if (!localPath) {
            this.dispatch({
                type: "ui/status",
                text: `Open failed: could not save ${selectedFilename} locally`,
            });
            return;
        }

        try {
            await this.transport.openPathInDefaultApp(localPath);
            this.dispatch({
                type: "ui/status",
                text: scope === "allSessions"
                    ? `Opened ${shortSessionIdValue(sessionId)} ${selectedFilename} in the default app`
                    : `Opened ${selectedFilename} in the default app`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Open failed: ${error?.message || String(error)}`,
            });
        }
    }

    async downloadSelectedArtifact() {
        const selectedItem = selectSelectedFileBrowserItem(this.getState());
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({ type: "ui/status", text: "No artifact selected" });
            return null;
        }
        this.dispatch({
            type: "ui/status",
            text: `Downloading ${selectedItem.filename}...`,
        });
        const download = await this.saveArtifactDownload(selectedItem.sessionId, selectedItem.filename);
        if (!download?.localPath) return null;
        this.dispatch({
            type: "ui/status",
            text: `Downloaded ${selectedItem.filename}`,
        });
        return download;
    }

    /**
     * Bulk selection on the artifact list.
     *
     * Marking never moves selectedArtifactId, so the preview keeps showing the
     * artifact it was already on while you mark others for deletion.
     */
    toggleArtifactMark(item) {
        if (!item?.id) return;
        this.dispatch({ type: "files/toggleMark", artifactId: item.id });
    }

    /** Shift-click: mark the contiguous run between the anchor and `item`. */
    markArtifactRange(item) {
        if (!item?.id) return;
        const items = selectFileBrowserItems(this.getState());
        const marked = this.getState().files.markedIds || [];
        const anchorId = marked.length > 0 ? marked[marked.length - 1] : this.getState().files.selectedArtifactId;
        const from = items.findIndex((entry) => entry.id === anchorId);
        const to = items.findIndex((entry) => entry.id === item.id);
        if (to < 0) return;
        if (from < 0) {
            this.dispatch({ type: "files/toggleMark", artifactId: item.id });
            return;
        }
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        const range = items.slice(lo, hi + 1).map((entry) => entry.id);
        this.dispatch({ type: "files/setMarks", artifactIds: [...new Set([...marked, ...range])] });
    }

    clearArtifactMarks() {
        this.dispatch({ type: "files/clearMarks" });
    }

    /** Delete every marked artifact. Confirms once for the whole batch. */
    async deleteMarkedArtifacts({ confirmed = false } = {}) {
        const state = this.getState();
        const markedIds = state.files.markedIds || [];
        if (markedIds.length === 0) {
            this.dispatch({ type: "ui/status", text: "No artifacts marked" });
            return false;
        }
        if (typeof this.transport.deleteArtifact !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact deletion is not supported by this transport" });
            return false;
        }
        if (!confirmed) {
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Delete Artifacts",
                    message: `Delete ${markedIds.length} artifact${markedIds.length === 1 ? "" : "s"}? This action cannot be undone.`,
                    confirmLabel: `Delete ${markedIds.length}`,
                    action: "deleteMarkedArtifacts",
                    previousFocus: state.ui.focusRegion,
                },
            });
            return false;
        }

        const touchedSessions = new Set();
        let deleted = 0;
        const failures = [];
        for (const id of markedIds) {
            const slash = String(id).indexOf("/");
            if (slash <= 0) continue;
            const sessionId = id.slice(0, slash);
            const filename = id.slice(slash + 1);
            try {
                await this.transport.deleteArtifact(sessionId, filename);
                this.dispatch({ type: "files/deleted", sessionId, filename });
                touchedSessions.add(sessionId);
                deleted += 1;
            } catch (error) {
                // Keep going: one failure should not strand the rest of the batch.
                failures.push(`${filename}: ${error?.message || String(error)}`);
            }
        }
        for (const sessionId of touchedSessions) {
            await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
        }
        this.dispatch({ type: "files/clearMarks" });
        this.dispatch({
            type: "ui/status",
            text: failures.length > 0
                ? `Deleted ${deleted}, ${failures.length} failed — ${failures[0]}`
                : `Deleted ${deleted} artifact${deleted === 1 ? "" : "s"}`,
        });
        return failures.length === 0;
    }

    async deleteSelectedArtifact({ confirmed = false } = {}) {
        const state = this.getState();
        const selectedItem = selectSelectedFileBrowserItem(state);
        if (!selectedItem?.sessionId || !selectedItem?.filename) {
            this.dispatch({ type: "ui/status", text: "No artifact selected" });
            return false;
        }

        const scope = selectFilesScope(state);
        const artifactLabel = scope === "allSessions"
            ? `${shortSessionIdValue(selectedItem.sessionId)} ${selectedItem.filename}`
            : selectedItem.filename;

        if (!confirmed) {
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Delete Artifact",
                    message: `Delete artifact "${artifactLabel}"? This action cannot be undone.`,
                    confirmLabel: "Delete",
                    action: "deleteArtifact",
                    sessionId: selectedItem.sessionId,
                    filename: selectedItem.filename,
                    previousFocus: state.ui.focusRegion,
                },
            });
            return false;
        }

        if (typeof this.transport.deleteArtifact !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact deletion is not supported by this transport" });
            return false;
        }

        try {
            await this.transport.deleteArtifact(selectedItem.sessionId, selectedItem.filename);
            this.dispatch({
                type: "files/deleted",
                sessionId: selectedItem.sessionId,
                filename: selectedItem.filename,
            });
            await this.ensureFilesForSession(selectedItem.sessionId, { force: true }).catch(() => null);
            const nextSelectedItem = selectSelectedFileBrowserItem(this.getState());
            if (nextSelectedItem?.sessionId && nextSelectedItem?.filename) {
                await this.ensureFilePreview(nextSelectedItem.sessionId, nextSelectedItem.filename).catch(() => null);
            }
            this.dispatch({
                type: "ui/status",
                text: scope === "allSessions"
                    ? `Deleted ${shortSessionIdValue(selectedItem.sessionId)} ${selectedItem.filename}`
                    : `Deleted ${selectedItem.filename}`,
            });
            return true;
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Delete failed: ${error?.message || String(error)}`,
            });
            return false;
        }
    }

    async openArtifactPicker() {
        const state = this.getState();
        const activeSessionId = state.sessions.activeSessionId;
        if (!activeSessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }

        const artifactLinks = selectActiveArtifactLinks(state);
        const httpLinks = selectActiveHttpLinks(state);
        if (artifactLinks.length === 0 && httpLinks.length === 0) {
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        const preferredSelectedFilename = this.getState().files.bySessionId[activeSessionId]?.selectedFilename || null;
        const preferredSelectedId = preferredSelectedFilename
            ? `${activeSessionId}/${preferredSelectedFilename}`
            : null;
        const nextModal = this.buildArtifactPickerModal({
            artifactLinks,
            httpLinks,
            previousFocus: state.ui.focusRegion,
            selectedId: preferredSelectedId,
        });

        if (!nextModal) {
            this.dispatch({ type: "ui/status", text: "No linked artifacts or URLs in the current chat view" });
            return;
        }

        this.dispatch({ type: "ui/modal", modal: nextModal });
        this.dispatch({ type: "ui/status", text: "Select a linked item and press Enter to open or download it" });
    }

    async downloadArtifactModalSelection() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactPicker") return;

        const selectedItem = modal.items?.[modal.selectedIndex || 0];
        if (!selectedItem) return;

        if (selectedItem.kind === "url") {
            if (typeof this.transport.openUrlInDefaultBrowser !== "function") {
                this.dispatch({ type: "ui/status", text: "Opening URLs is not supported by this transport" });
                return;
            }

            this.dispatch({
                type: "ui/status",
                text: `Opening ${selectedItem.href}...`,
            });
            await this.transport.openUrlInDefaultBrowser(selectedItem.href);
            this.replaceArtifactPickerModal(selectedItem.id);
            this.dispatch({
                type: "ui/status",
                text: `Opened ${selectedItem.href}`,
            });
            return;
        }

        if (selectedItem.kind === "downloadAll") {
            const pending = (modal.items || []).filter((item) => {
                if (item.kind !== "artifact") return false;
                const download = this.getState().files.bySessionId[item.sessionId]?.downloads?.[item.filename];
                return !download?.localPath;
            });

            if (pending.length === 0) {
                this.dispatch({ type: "ui/status", text: "All artifacts already downloaded" });
                return;
            }

            this.dispatch({
                type: "ui/status",
                text: `Downloading ${pending.length} artifacts...`,
            });

            let downloadedCount = 0;
            for (const item of pending) {
                const download = await this.saveArtifactDownload(item.sessionId, item.filename);
                if (download?.localPath) downloadedCount += 1;
            }

            this.replaceArtifactPickerModal(selectedItem.id);
            this.dispatch({
                type: "ui/status",
                text: `Downloaded ${downloadedCount}/${pending.length} artifacts`,
            });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: `Downloading ${selectedItem.filename}...`,
        });
        const download = await this.saveArtifactDownload(selectedItem.sessionId, selectedItem.filename);
        if (!download?.localPath) return;

        this.replaceArtifactPickerModal(selectedItem.id);
        this.dispatch({
            type: "ui/status",
            text: `Downloaded ${selectedItem.filename}`,
        });
    }

    async moveFileSelection(delta) {
        const scope = selectFilesScope(this.getState());
        await this.ensureFilesForScope(scope);
        const items = selectFileBrowserItems(this.getState());
        if (items.length === 0) return;

        const currentItem = selectSelectedFileBrowserItem(this.getState()) || items[0];
        const currentIndex = Math.max(0, items.findIndex((item) => item.id === currentItem?.id));
        const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
        const nextItem = items[nextIndex];
        if (!nextItem?.sessionId || !nextItem?.filename) return;

        if (scope === "allSessions") {
            this.dispatch({
                type: "files/selectGlobal",
                artifactId: nextItem.id,
            });
        } else {
            this.dispatch({
                type: "files/select",
                sessionId: nextItem.sessionId,
                filename: nextItem.filename,
            });
        }
        await this.ensureFilePreview(nextItem.sessionId, nextItem.filename).catch(() => {});
        this.dispatch({
            type: "ui/status",
            text: scope === "allSessions"
                ? `Previewing ${shortSessionIdValue(nextItem.sessionId)} ${nextItem.filename}`
                : `Previewing ${nextItem.filename}`,
        });
    }

    async selectFileBrowserItem(item) {
        if (!item?.sessionId || !item?.filename) return;
        this.dispatch({ type: "files/previewOrigin", origin: "list" });
        const scope = selectFilesScope(this.getState());
        if (scope === "allSessions") {
            this.dispatch({
                type: "files/selectGlobal",
                artifactId: item.id,
            });
        } else {
            this.dispatch({
                type: "files/select",
                sessionId: item.sessionId,
                filename: item.filename,
            });
        }
        await this.ensureFilePreview(item.sessionId, item.filename).catch(() => {});
        this.dispatch({
            type: "ui/status",
            text: scope === "allSessions"
                ? `Previewing ${shortSessionIdValue(item.sessionId)} ${item.filename}`
                : `Previewing ${item.filename}`,
        });
    }

    toggleFilePreviewFullscreen() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        const fileState = state.files.bySessionId[sessionId];
        const isCurrentlyFullscreen = Boolean(state.files.fullscreen);
        // Allow exiting fullscreen unconditionally. Block entering it
        // when no file is selected — but tell the user *why* the button
        // appeared to do nothing instead of failing silently.
        if (!isCurrentlyFullscreen && !fileState?.selectedFilename) {
            this.dispatch({
                type: "ui/status",
                text: "Select a file before entering fullscreen",
            });
            return;
        }
        const nextFullscreen = !isCurrentlyFullscreen;
        this.dispatch({
            type: "files/fullscreen",
            fullscreen: nextFullscreen,
        });
        this.dispatch({
            type: "ui/status",
            text: nextFullscreen
                ? `Fullscreen files browser: ${fileState?.selectedFilename || ""}`
                : `Closed fullscreen files browser`,
        });
    }

    toggleFocusedPaneFullscreen() {
        const state = this.getState();
        const focusRegion = state.ui.focusRegion;
        const currentFullscreenPane = state.ui.fullscreenPane || null;
        const targetPane = focusRegion === FOCUS_REGIONS.PROMPT
            ? currentFullscreenPane
            : focusRegion;
        if (!FULLSCREENABLE_PANES.has(targetPane)) return;
        if (targetPane === FOCUS_REGIONS.INSPECTOR && state.ui.inspectorTab === "files") return;

        const nextFullscreenPane = currentFullscreenPane === targetPane ? null : targetPane;
        this.dispatch({
            type: "ui/fullscreenPane",
            fullscreenPane: nextFullscreenPane,
        });
        this.dispatch({
            type: "ui/status",
            text: nextFullscreenPane
                ? `Fullscreen ${targetPane} pane`
                : `Closed fullscreen ${targetPane} pane`,
        });
        if (!nextFullscreenPane && focusRegion === FOCUS_REGIONS.PROMPT) {
            this.setFocus(targetPane);
        }
    }

    openFilesFilter() {
        const scope = selectFilesScope(this.getState());
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "filesFilter",
                title: "Files Filter",
                previousFocus: this.getState().ui.focusRegion,
                selectedIndex: 0,
                items: [
                    {
                        id: "scope",
                        label: "Scope",
                        description: "Choose whether the files browser shows the selected session tree or aggregates exported files across all sessions.",
                        options: [
                            { id: "selectedSession", label: "Selected session tree" },
                            { id: "allSessions", label: "All sessions" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({
            type: "ui/status",
            text: `Editing files filter: Scope = ${scope === "allSessions" ? "All sessions" : "Selected session tree"}`,
        });
    }

    /**
     * Latch a navigation intent (deep link) onto a session id. The intent
     * outranks in-memory selection and the profile's activeSessionId until
     * the user navigates manually or changes a filter. Also the retry path
     * for a failed intent: re-latching resets it to pending.
     */
    setNavigationIntent(sessionId) {
        const id = String(sessionId || "").trim();
        if (!id) return;
        this.dispatch({ type: "sessions/navigationIntent", sessionId: id });
        const state = this.getState();
        if (state.sessions.byId[id]) {
            this.loadSession(id).catch((error) => {
                this.dispatch({
                    type: "sessions/navigationIntentFailed",
                    sessionId: id,
                    errorKind: classifyNavigationLoadError(error),
                });
            });
            return;
        }
        if (Object.keys(state.sessions.byId).length > 0) {
            this.scheduleSessionsRefresh(0);
        }
    }

    async loadSession(sessionId) {
        if (!sessionId) return;
        const active = this.getState().sessions.activeSessionId;
        if (active !== sessionId) {
            if (this.getState().ui.promptEdit) {
                this.exitPendingPromptEdit({ restoreDraft: true });
            }
            this.dispatch({ type: "sessions/selected", sessionId });
            // Sequence-tab turn selection/expansion is per-session; clear it on
            // switch so a stale turn index doesn't carry into another session.
            this.dispatch({ type: "ui/sequenceExpandedTurns", turns: [] });
            this.dispatch({ type: "ui/sequenceSelectedTurn", turn: null });
        }
        if (this.getState().sessions.byId[sessionId]?.isGroup) {
            this.detachActiveSession();
            return;
        }
        await this.ensureSessionHistory(sessionId, { force: true });
        await this.syncSessionDetail(sessionId).catch(() => {});
        this.attachActiveSession(sessionId);
        this.ensureInspectorData().catch(() => {});
        // Canvas snapshot rides the selection burst. Invalidate-then-fetch on
        // every selection, deliberately: the live event stream only covers the
        // ATTACHED session, so a session's canvas knowledge goes stale the
        // moment you switch away — re-selection is the continuity break, and
        // one indexed limit-1 row is noise against the burst above.
        this.dispatch({ type: "canvas/snapshotInvalidate", sessionId });
        this.ensureCanvasSnapshot(sessionId).catch(() => {});
    }

    /**
     * Reconcile outbox state against a single CMS event. Removes outbox items
     * whose `clientMessageIds` were observed as a durable `user.message`
     * (acknowledged → drop the local optimistic item) or as a
     * `pending_messages.cancelled` (cancel confirmed → drop the cancelling
     * item). Pure side-effect helper that is safe to call repeatedly.
     *
     * Must be invoked from BOTH per-event paths (`mergeSessionEvent`) and
     * bulk-load paths (`ensureSessionHistory`). Bulk loads previously skipped
     * this and left outbox items stranded as "queued" or "cancelling" forever
     * even after the durable event was already in CMS.
     */
    reconcileOutboxAgainstEvent(sessionId, event) {
        if (!sessionId || !event) return;
        if (event.eventType === "user.message") {
            const content = event?.data?.content;
            const clientMessageIds = Array.isArray(event?.data?.clientMessageIds)
                ? event.data.clientMessageIds.filter((id) => typeof id === "string")
                : (typeof event?.data?.clientMessageId === "string" ? [event.data.clientMessageId] : []);
            if (clientMessageIds.length > 0) {
                for (const id of clientMessageIds) {
                    this.acknowledgeOutboxPrompt(sessionId, content, id);
                }
            } else if (typeof content === "string" && content.trim()) {
                // Fallback: text-match acknowledgement until clientMessageId is
                // plumbed through every layer.
                this.acknowledgeOutboxPrompt(sessionId, content);
            }
            return;
        }
        if (event.eventType === "pending_messages.cancelled") {
            const clientMessageIds = Array.isArray(event?.data?.clientMessageIds)
                ? event.data.clientMessageIds.filter((id) => typeof id === "string")
                : (typeof event?.data?.clientMessageId === "string" ? [event.data.clientMessageId] : []);
            this.acknowledgeCancelledOutboxPrompt(sessionId, clientMessageIds);
        }
    }

    /**
     * Act on a `session.artifact_presented` event from the live stream.
     *
     * Separate from mergeSessionEvent so the guards are testable on their own
     * and so the merge path stays a straight line. Returns whether it revealed.
     */
    maybeRevealPresentedArtifact(sessionId, event) {
        const filename = String(event?.data?.filename || "").trim();
        if (!filename) return false;
        if (sessionId !== this.getState().sessions.activeSessionId) return false;

        const createdAt = event?.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt) && Date.now() - createdAt > PRESENTED_ARTIFACT_FRESHNESS_MS) {
            return false;
        }

        // Same destination a user click reaches: the artifact reader, with the
        // chat still beside it. `fullscreen` from the tool means "give it the
        // whole window" and stays the phone/fullscreen path.
        const fullscreen = event?.data?.fullscreen === true;
        this.revealArtifact(sessionId, filename, fullscreen
            ? { fullscreen: true }
            : { pane: true }).catch(() => {});
        return true;
    }

    /**
     * Apply a live `session.canvas_updated` event: converge content always,
     * flip the right column only when it is unmistakably appropriate.
     *
     * Flip guards (the artifact-presented set, plus the user's own choices):
     * active session only, fresh only, not already in canvas mode, and never
     * after the user has manually toggled away this session — their explicit
     * choice downgrades flips to the unseen-changes badge.
     */
    applyCanvasUpdate(sessionId, event) {
        const rev = Number(event?.data?.rev);
        if (!sessionId || !Number.isFinite(rev) || rev <= 0) return false;
        const rawSlot = Number(event?.data?.slot);
        const slot = Number.isInteger(rawSlot) && rawSlot >= 1 && rawSlot <= 5 ? rawSlot : 1;
        this.dispatch({
            type: "canvas/updated",
            sessionId,
            slot,
            ...(typeof event?.data?.name === "string" ? { name: event.data.name } : {}),
            rev,
            note: typeof event?.data?.note === "string" ? event.data.note : "",
            sizeBytes: event?.data?.sizeBytes,
            responseContract: event?.data?.responseContract,
        });

        const state = this.getState();
        if (sessionId !== state.sessions.activeSessionId) return true;
        // The opt-out is PER SLOT: leaving one canvas by hand must not
        // silence a different canvas's first draw.
        if (state.canvas.prefs[canvasPrefKey(sessionId, slot)]?.optedOut) return true;
        const createdAt = event?.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt) && Date.now() - createdAt > PRESENTED_ARTIFACT_FRESHNESS_MS) {
            return true;
        }
        // canvas/flip rather than a plain mode change: it ticks flipSeq even
        // when the mode is already "canvas", because a phone can be off its
        // canvas tab while the mode state still says canvas — the tick is
        // what brings the tab back. On desktop the repeat dispatch is a no-op.
        this.dispatch({ type: "canvas/flip", sessionId, slot });
        return true;
    }

    /**
     * The cold-load snapshot: one indexed lookup against the full durable log,
     * fired per session as part of the selection burst and memoized. Its
     * result is definitive both ways — an event means a canvas exists at that
     * rev; nothing means none has ever been drawn. The client never
     * blind-loads canvas.html on a hunch.
     */
    /**
     * A structured response posted by the canvas page, on its way to the
     * agent. The CanvasFrame already proved provenance (the message came from
     * the live canvas iframe and nothing else); this is the rest of the
     * pipeline: validate against the CURRENT revision's contract (no contract
     * → accept nothing), rate-limit (the page is agent-authored JS speaking
     * as the viewer), then send it as a real user message through the
     * ordinary transport path — no outbox, no optimistic chat bubble. The
     * history pipeline recognizes the canonical prefix and keeps it out of
     * the portal chat pane; the transcript still records it for provenance.
     */
    submitCanvasAction(sessionId, message) {
        if (!sessionId) return Promise.resolve({ ok: false, reason: "no session" });
        // Creator-only, mirrored from the server's enforcement (the server is
        // the authority; this is the friendly refusal). The canvas mutates —
        // a shared viewer may be looking at a different revision than the one
        // the creator is conversing through, so their clicks must not speak.
        // Who may ring is the SERVER's decision (owner, admin, or anyone with
        // session write — interactive-canvas-apps Part E). The client no
        // longer pre-refuses non-owners: a write-shared collaborator's click
        // must reach the agent, and the server's refusal for a read-only
        // viewer comes back as the result's reason.
        const contract = this.getState().canvas.bySessionId[sessionId]?.responseContract || null;
        const verdict = validateCanvasAction(contract, message);
        if (!verdict.ok) return Promise.resolve(verdict);
        if (!this.canvasActionLimiters) this.canvasActionLimiters = new Map();
        let limiter = this.canvasActionLimiters.get(sessionId);
        if (!limiter) {
            limiter = createCanvasActionLimiter();
            this.canvasActionLimiters.set(sessionId, limiter);
        }
        if (!limiter()) return Promise.resolve({ ok: false, reason: "rate limited" });
        const prompt = formatCanvasActionPrompt(verdict.action, verdict.data);
        return this.transport.sendMessage(sessionId, prompt, { enqueueOnly: true })
            .then(() => {
                this.syncSessionEvents(sessionId).catch(() => {});
                return { ok: true, action: verdict.action };
            })
            .catch((error) => ({ ok: false, reason: error?.message || String(error) }));
    }

    async ensureCanvasSnapshot(sessionId) {
        if (!sessionId) return;
        if (this.getState().canvas.bySessionId[sessionId]?.snapshotLoaded) return;
        if (typeof this.transport.getSessionEventsBefore !== "function") {
            // A transport without the filtered query (older direct mode) still
            // converges via live events; record the attempt so we do not spin.
            this.dispatch({ type: "canvas/snapshot", sessionId, rev: 0 });
            return;
        }
        try {
            // A 30-event window, not 1: five interleaved slots mean the top
            // event only describes the most recently drawn slot. Latest per
            // slot wins; every drawn slot gets its snapshot.
            const rows = await this.transport.getSessionEventsBefore(
                sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_updated"],
            );
            const bySlot = new Map();
            for (const row of Array.isArray(rows) ? rows : []) {
                const slot = Number(row?.data?.slot) || 1;
                const rev = Number(row?.data?.rev) || 0;
                if (!bySlot.has(slot) || rev > (Number(bySlot.get(slot)?.data?.rev) || 0)) bySlot.set(slot, row);
            }
            // Always at least a slot-1 snapshot (rev 0 marks snapshotLoaded
            // so this does not respin).
            if (!bySlot.has(1)) bySlot.set(1, null);
            let anyDrawn = false;
            for (const [slot, top] of bySlot) {
                const rev = Number(top?.data?.rev) || 0;
                if (rev > 0) anyDrawn = true;
                this.dispatch({
                    type: "canvas/snapshot",
                    sessionId,
                    slot,
                    rev,
                    ...(typeof top?.data?.name === "string" ? { name: top.data.name } : {}),
                    note: typeof top?.data?.note === "string" ? top.data.note : "",
                    sizeBytes: top?.data?.sizeBytes,
                    responseContract: top?.data?.responseContract,
                });
            }
            // The latest data tick per slot is that page's cold-load state —
            // replay it so a freshly loaded shell reconstructs without the
            // agent.
            if (anyDrawn) {
                const dataRows = await this.transport.getSessionEventsBefore(
                    sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_data"],
                ).catch(() => []);
                const tickBySlot = new Map();
                for (const row of Array.isArray(dataRows) ? dataRows : []) {
                    const slot = Number(row?.data?.slot) || 1;
                    const dr = Number(row?.data?.dataRev) || 0;
                    if (!tickBySlot.has(slot) || dr > (Number(tickBySlot.get(slot)?.data?.dataRev) || 0)) tickBySlot.set(slot, row);
                }
                for (const [slot, tick] of tickBySlot) {
                    if (!tick?.data?.dataRev) continue;
                    this.dispatch({
                        type: "canvas/data",
                        sessionId,
                        slot,
                        dataRev: Number(tick.data.dataRev),
                        payload: tick.data.payload,
                        note: typeof tick.data.note === "string" ? tick.data.note : "",
                    });
                }
            }
        } catch {
            // Leave snapshotLoaded unset — the next selection retries.
        }
    }

    /**
     * An agent asked to PRESENT an already-drawn canvas — no bytes, no rev,
     * nothing marked unseen. Same guards as a draw's auto-flip: only the
     * active session, only a fresh event (a reconnect replay must not yank
     * the view), and the user's manual dismissal of that slot still wins.
     */
    applyCanvasPresented(sessionId, event) {
        const rawSlot = Number(event?.data?.slot);
        const slot = Number.isInteger(rawSlot) && rawSlot >= 1 && rawSlot <= 5 ? rawSlot : 1;
        if (!sessionId) return false;
        const state = this.getState();
        if (sessionId !== state.sessions.activeSessionId) return false;
        if (state.canvas.prefs[canvasPrefKey(sessionId, slot)]?.optedOut) return false;
        const createdAt = event?.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt) && Date.now() - createdAt > PRESENTED_ARTIFACT_FRESHNESS_MS) {
            return false;
        }
        this.dispatch({ type: "canvas/flip", sessionId, slot });
        return true;
    }

    /**
     * Listen for canvas KV changes on a session (the live path of the canvas
     * KV store). Returns an unsubscriber. Frames use this to post
     * `canvas-kv-change` into their page.
     */
    subscribeCanvasKv(sessionId, callback) {
        if (!sessionId || typeof callback !== "function") return () => {};
        if (!this._canvasKvListeners) this._canvasKvListeners = new Map();
        if (!this._canvasKvListeners.has(sessionId)) this._canvasKvListeners.set(sessionId, new Set());
        const set = this._canvasKvListeners.get(sessionId);
        set.add(callback);
        return () => {
            set.delete(callback);
            if (set.size === 0) this._canvasKvListeners.delete(sessionId);
        };
    }

    applyCanvasDataEvent(sessionId, event) {
        this.dispatch({
            type: "canvas/data",
            sessionId,
            slot: Number(event?.data?.slot) || 1,
            dataRev: Number(event?.data?.dataRev),
            payload: event?.data?.payload,
            // Plane-fed ticks (the canvas data plane's live mirror) carry
            // their own seq lineage and the patch that produced them — the
            // reducer orders plane ticks by planeSeq and hands the patch to
            // pages that opt into targeted updates.
            ...(Number.isFinite(Number(event?.data?.planeSeq)) ? { planeSeq: Number(event.data.planeSeq) } : {}),
            ...(event?.data?.patch && typeof event.data.patch === "object" ? { patch: event.data.patch } : {}),
            note: typeof event?.data?.note === "string" ? event.data.note : "",
        });
    }

    mergeSessionEvent(sessionId, event) {
        if (!sessionId || !event) return false;
        // Plane-synthesized canvas events are TRANSIENT: they update canvas
        // state and nothing else. They carry no seq — letting them into
        // history would corrupt the replay cursor — and they must never
        // appear in the transcript.
        if (event.transient === true) {
            if (event.eventType === "session.canvas_data") {
                this.applyCanvasDataEvent(sessionId, event);
            }
            if (event.eventType === "session.canvas_kv") {
                // KV changes never touch the reducer: they go straight to
                // the canvas frames listening for this session, which post
                // them into the page as `canvas-kv-change`.
                const listeners = this._canvasKvListeners?.get(sessionId);
                if (listeners) {
                    for (const cb of listeners) {
                        try { cb(event.data); } catch { /* one frame's problem */ }
                    }
                }
            }
            if (event.eventType === "session.canvas_plane_released") {
                // The plane died for this session (server error/rollback).
                // Clear the reducer's takeover so legacy durable ticks — the
                // fallback path — apply again instead of being dropped.
                this.dispatch({ type: "canvas/planeReleased", sessionId });
            }
            return false;
        }
        const state = this.getState();
        const existing = state.history.bySessionId.get(sessionId) || { chat: [], activity: [], lastSeq: 0 };
        if (event.seq <= (existing.lastSeq || 0)) return false;
        this.dispatch({
            type: "history/set",
            sessionId,
            history: appendEventToHistory(existing, event),
        });
        // The input_required_started event carries the full question payload and
        // reaches us on the live event stream — well ahead of the slower
        // customStatus detail-sync (scheduleSessionDetailSync below). Set
        // pendingQuestion + status synchronously so an answer typed the moment the
        // question appears takes the direct sendAnswer path instead of being
        // misrouted into the outbox queue, where it would sit until a later send
        // flushed it. The eventual detail-sync reconciles to the authoritative
        // customStatus.
        if (event.eventType === "session.input_required_started" && event.data?.question) {
            this.dispatch({
                type: "sessions/merged",
                session: {
                    sessionId,
                    status: "input_required",
                    pendingQuestion: {
                        question: event.data.question,
                        choices: Array.isArray(event.data.choices) ? event.data.choices : undefined,
                        allowFreeform: event.data.allowFreeform ?? true,
                    },
                },
            });
        }
        // show_artifact: the agent is presenting something to look at, so the
        // inspector switches to Files and opens that preview live.
        //
        // Three guards, because "the UI moves on its own" is only acceptable
        // when it is unmistakably a response to what is happening right now:
        //
        //  - active session only. A background session finishing a dashboard
        //    must never yank the pane away from the session being read.
        //  - fresh events only. This path also runs for the catch-up burst
        //    after a reconnect; replaying an hour-old presentation as if it
        //    just happened would be a jump scare, not a feature.
        //  - live path only. Bulk history loads (ensureSessionHistory) do not
        //    come through here, so merely OPENING a session never auto-opens
        //    whatever it last presented. Reopening is what the artifact link
        //    in the transcript and the deep link are for.
        if (event.eventType === "session.artifact_presented") {
            this.maybeRevealPresentedArtifact(sessionId, event);
        }
        // Canvas: CONTENT convergence is ungated — a stale canvas_updated in a
        // reconnect replay must still advance latestRev and refresh a mounted
        // pane. Only the FLIP is guarded (below). This deliberately diverges
        // from artifact_presented, which drops stale events outright: a
        // presentation is an action, a canvas is state.
        if (event.eventType === "session.canvas_updated") {
            this.applyCanvasUpdate(sessionId, event);
        }
        if (event.eventType === "session.canvas_presented") {
            this.applyCanvasPresented(sessionId, event);
        }
        if (event.eventType === "session.canvas_data") {
            this.applyCanvasDataEvent(sessionId, event);
        }
        this.reconcileOutboxAgainstEvent(sessionId, event);
        const derivedModel = extractSessionModelFromEvent(event);
        const currentSession = this.getState().sessions.byId[sessionId] || { sessionId };
        const derivedContextUsage = applySessionUsageEvent(currentSession.contextUsage, event.eventType, event.data, {
            timestamp: event.createdAt,
        });
        if (derivedModel || derivedContextUsage) {
            this.dispatch({
                type: "sessions/merged",
                session: {
                    sessionId,
                    ...(derivedModel || {}),
                    ...(derivedContextUsage ? { contextUsage: derivedContextUsage } : {}),
                },
            });
        }
        this.maybeFlushQueuedOutbox(sessionId, this.getState().sessions.byId[sessionId] || currentSession);
        this.scheduleSessionDetailSync(sessionId);
        return true;
    }

    async syncSessionEvents(sessionId) {
        if (!sessionId || typeof this.transport.getSessionEvents !== "function") return;
        const existing = this.getState().history.bySessionId.get(sessionId);
        if (!existing?.events) {
            await this.ensureSessionHistory(sessionId, { force: true });
            return;
        }
        const afterSeq = Number(existing.lastSeq || 0);
        let events = null;
        try {
            events = await this.transport.getSessionEvents(sessionId, afterSeq, 200);
        } catch (error) {
            if (isSessionGoneError(error)) {
                this.handleSessionGone(sessionId);
                return;
            }
            throw error;
        }
        if (!Array.isArray(events) || events.length === 0) return;
        for (const event of events) {
            this.mergeSessionEvent(sessionId, event);
        }
    }

    attachActiveSession(sessionId) {
        if (this.activeSessionSubscriptionId === sessionId && this.activeSessionUnsub) {
            return;
        }
        this.detachActiveSession();
        this.activeSessionSubscriptionId = sessionId;
        this.activeSessionUnsub = this.transport.subscribeSession(sessionId, (event) => {
            this.mergeSessionEvent(sessionId, event);
        });
        this.syncSessionEvents(sessionId).catch(() => {});
    }

    scheduleSessionDetailSync(sessionId, delayMs = 250) {
        if (typeof this.transport.getSession !== "function" || !sessionId) return;
        if (isSessionGroupRowId(sessionId)) return;
        if (this.activeSessionDetailTimer) clearTimeout(this.activeSessionDetailTimer);
        this.activeSessionDetailSessionId = sessionId;
        this.activeSessionDetailTimer = setTimeout(() => {
            const targetSessionId = this.activeSessionDetailSessionId;
            this.activeSessionDetailTimer = null;
            this.activeSessionDetailSessionId = null;
            this.syncSessionDetail(targetSessionId).catch(() => {});
        }, delayMs);
    }

    scheduleSessionsRefresh(delayMs = 0) {
        if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
        this.sessionRefreshTimer = setTimeout(() => {
            this.sessionRefreshTimer = null;
            this.refreshSessions().catch(() => {});
        }, Math.max(0, delayMs));
    }

    async syncSessionDetail(sessionId) {
        if (typeof this.transport.getSession !== "function" || !sessionId) return;
        if (isSessionGroupRowId(sessionId)) return;
        let session = null;
        try {
            session = await this.transport.getSession(sessionId);
        } catch (error) {
            if (isSessionGoneError(error)) {
                this.handleSessionGone(sessionId);
                return;
            }
            throw error;
        }
        if (!session) return;
        const previousSession = this.getState().sessions.byId[sessionId] || null;
        const patch = buildSessionMergePatch(previousSession, session);
        if (patch || previousSession?.rowVisualStatusCandidate) {
            this.dispatch({ type: "sessions/merged", session: patch || { sessionId } });
        }
        this.maybeFlushQueuedOutbox(sessionId, session);
    }

    async createSession(options = {}) {
        try {
            const requestOptions = this.applyActiveGroupDefault(options);
            const created = await this.transport.createSession(requestOptions);
            await this.placeCreatedSessionInGroup(created, requestOptions.groupId ?? null);
            await this.refreshSessions();
            await this.loadSession(created.sessionId);
            this.revealCreatedSession();
            this.dispatch({ type: "ui/status", text: `Created session ${created.sessionId.slice(0, 8)}` });
            return created;
        } catch (error) {
            this.dispatch({ type: "ui/status", text: error?.message || String(error) || "Failed to create session" });
            return null;
        }
    }

    async createSessionForAgent(agentName, options = {}) {
        if (typeof this.transport.createSessionForAgent !== "function") {
            throw new Error("Named-agent session creation is not supported by this transport");
        }
        try {
            const requestOptions = this.applyActiveGroupDefault(options);
            const created = await this.transport.createSessionForAgent(agentName, requestOptions);
            await this.placeCreatedSessionInGroup(created, requestOptions.groupId ?? null);
            await this.refreshSessions();
            await this.loadSession(created.sessionId);
            this.revealCreatedSession();
            this.dispatch({
                type: "ui/status",
                text: `Created ${formatAgentDisplayTitle(agentName, options.title)} session ${created.sessionId.slice(0, 8)}`,
            });
            return created;
        } catch (error) {
            this.dispatch({ type: "ui/status", text: error?.message || String(error) || "Failed to create session" });
            return null;
        }
    }

    /**
     * Post-create placement follow-up. createSession's groupId only places
     * when an owner principal reaches the catalog (web mode places
     * server-side; the local TUI passes no owner), so when a group was
     * requested, place explicitly — idempotent where the server already did.
     * Skipped when the create response already reports the placement.
     */
    async placeCreatedSessionInGroup(created, groupId) {
        if (!groupId || !created?.sessionId) return;
        if (typeof this.transport.placeSessionsInGroup !== "function") return;
        if ((created.viewerGroupId ?? null) === groupId) return;
        await this.transport.placeSessionsInGroup([created.sessionId], groupId).catch(() => {});
    }

    getMovableGroupSessionSelection() {
        const state = this.getState();
        // Deselected means deselected. The active session still drives the
        // chat and inspector panes after an empty-space click, but it is no
        // longer a LIST selection — so list actions must not silently act on
        // it. With nothing selected the folder button offers only "New Group".
        const activeIds = state.sessions.activeSessionId && !state.sessions.listDeselected
            ? [state.sessions.activeSessionId]
            : [];
        const selectedIds = Array.isArray(state.sessions.selectedIds) && state.sessions.selectedIds.length > 0
            ? state.sessions.selectedIds
            : activeIds;
        return selectedIds
            .map((id) => state.sessions.byId[id])
            .filter((session) => session && !session.isSystem && !session.isGroup && !session.parentSessionId);
    }

    async openMoveToGroupModal() {
        const state = this.getState();
        const eligible = this.getMovableGroupSessionSelection();

        if (eligible.length === 0) {
            // With a GROUP active, the folder button means "this group":
            // rename it. (Creating from here always made a second group —
            // reported as a surprise on the phone.)
            const active = state.sessions.activeSessionId
                ? state.sessions.byId[state.sessions.activeSessionId]
                : null;
            if (active?.isGroup && active.groupId) {
                return this.openRenameGroupModal(active);
            }
            // Nothing selected is a legitimate intent: make an empty folder to
            // drag sessions into, rather than scolding the user.
            return this.openCreateEmptyGroupModal();
        }
        if (typeof this.transport.listSessionGroups !== "function") {
            this.dispatch({ type: "ui/status", text: "Session groups are not supported by this transport" });
            return null;
        }

        // The server returns only the viewer's own groups, and placement is
        // viewer-private — any readable non-system selection is movable, so
        // mixed-owner selections are allowed and every group is offered.
        const groups = await this.transport.listSessionGroups().catch(() => []);
        const sessionIds = eligible.map((session) => session.sessionId);
        const firstGroupId = eligible.length === 1 ? eligible[0].groupId || null : null;
        const items = [
            {
                id: "__no_group__",
                kind: "noGroup",
                label: "[No Group]",
                description: "Remove the selected session(s) from any group.",
                groupId: null,
                memberCount: 0,
            },
            {
                id: "__new_group__",
                kind: "newGroup",
                label: "[New Group]",
                description: "Create a new group, then move the selected session(s) into it.",
                groupId: null,
                memberCount: 0,
            },
            ...(Array.isArray(groups) ? groups : []).map((group) => ({
                id: group.groupId,
                kind: "group",
                label: group.title || group.groupId,
                description: group.description || "Move selected session(s) into this group.",
                groupId: group.groupId,
                memberCount: group.memberCount ?? 0,
            })),
        ];
        const selectedIndex = firstGroupId
            ? Math.max(0, items.findIndex((item) => item.groupId === firstGroupId))
            : Math.min(1, items.length - 1);

        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionGroupPicker",
                title: eligible.length === 1 ? "Move Session to Group" : `Move ${eligible.length} Sessions to Group`,
                previousFocus: state.ui.focusRegion,
                sessionIds,
                sessionLabels: eligible.map((session) => session.title || session.sessionId.slice(0, 8)),
                selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
                items,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: "Choose a group, [New Group], or [No Group]",
        });
        return items;
    }

    async createSessionGroupFromSelection() {
        return this.openMoveToGroupModal();
    }

    /** Rename the active group in place (same modal, rename mode). */
    openRenameGroupModal(group) {
        if (typeof this.transport.updateSessionGroup !== "function") {
            this.dispatch({ type: "ui/status", text: "Group rename is not supported by this transport" });
            return null;
        }
        const state = this.getState();
        const current = String(group.title || "").trim();
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionGroupName",
                mode: "rename",
                groupId: group.groupId,
                title: "Rename Group",
                previousFocus: state.ui.focusRegion,
                sessionIds: [],
                value: current,
                cursorIndex: current.length,
                maxLength: 80,
            },
        });
        this.dispatch({ type: "ui/status", text: "Edit the group name and press Enter" });
        return null;
    }

    /** Name-and-create an EMPTY group (no sessions), ready to drag into. */
    async openCreateEmptyGroupModal() {
        if (typeof this.transport.createSessionGroup !== "function") {
            this.dispatch({ type: "ui/status", text: "Session grouping is not supported by this transport" });
            return null;
        }
        const state = this.getState();
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionGroupName",
                title: "New Group",
                previousFocus: state.ui.focusRegion,
                sessionIds: [],
                value: "",
                cursorIndex: 0,
                maxLength: 80,
            },
        });
        this.dispatch({ type: "ui/status", text: "Name the new group and press Enter" });
        return null;
    }

    async moveSessionsToGroup(groupId, sessionIds, { statusTitle = null } = {}) {
        const ids = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
        if (ids.length === 0) {
            this.dispatch({ type: "ui/status", text: "No sessions selected to move" });
            return null;
        }
        let placementResults = null;
        if (typeof this.transport.placeSessionsInGroup === "function") {
            placementResults = await this.transport.placeSessionsInGroup(ids, groupId ?? null);
        } else if (typeof this.transport.moveSessionsToGroup === "function") {
            await this.transport.moveSessionsToGroup(groupId ?? null, ids);
        } else if (groupId && typeof this.transport.assignSessionsToGroup === "function") {
            await this.transport.assignSessionsToGroup(groupId, ids);
        } else {
            this.dispatch({ type: "ui/status", text: "Moving sessions between groups is not supported by this transport" });
            return null;
        }

        const resultRows = Array.isArray(placementResults) ? placementResults.filter(Boolean) : null;
        const skippedRows = resultRows ? resultRows.filter((row) => row.placed !== true) : [];
        const placedCount = resultRows
            ? resultRows.filter((row) => row.placed === true).length
            : ids.length;

        this.dispatch({ type: "sessions/selectClear" });
        await this.refreshSessions();
        if (groupId && placedCount > 0) {
            await this.loadSession(`group:${groupId}`).catch(() => {});
        }
        const target = groupId ? `group ${statusTitle || groupId}` : "No Group";
        const skippedSummary = skippedRows.length > 0
            ? ` · skipped ${skippedRows.length} (${summarizePlacementSkips(skippedRows)})`
            : "";
        this.dispatch({
            type: "ui/status",
            text: placedCount > 0
                ? `Moved ${placedCount} session${placedCount === 1 ? "" : "s"} to ${target}${skippedSummary}`
                : `No sessions moved to ${target}${skippedSummary}`,
        });
        return placedCount > 0;
    }

    async confirmSessionGroupPickerModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupPicker") return;
        const item = modal.items?.[modal.selectedIndex || 0];
        if (!item) return;
        if (item.kind === "newGroup") {
            const baseTitle = (modal.sessionLabels || []).length === 1
                ? `${modal.sessionLabels[0]} Group`
                : `${(modal.sessionIds || []).length} Session Group`;
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "sessionGroupName",
                    title: "New Group",
                    previousFocus: modal.previousFocus,
                    sessionIds: modal.sessionIds || [],
                    value: baseTitle,
                    cursorIndex: baseTitle.length,
                    maxLength: 80,
                },
            });
            this.dispatch({ type: "ui/status", text: "Name the new group and press Enter" });
            return;
        }

        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) this.setFocus(previousFocus);
        try {
            await this.moveSessionsToGroup(item.kind === "noGroup" ? null : item.groupId, modal.sessionIds || [], { statusTitle: item.label });
        } catch (error) {
            this.dispatch({ type: "ui/status", text: `Move failed: ${error?.message || String(error)}` });
        }
    }

    updateSessionGroupNameModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({ type: "ui/modal", modal: { ...modal, ...nextModal } });
        return this.getState().ui.modal;
    }

    setSessionGroupNameValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        const safeValue = clampRenameSessionValue(value, modal.maxLength || 80);
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateSessionGroupNameModal({ value: safeValue, cursorIndex: safeCursor });
    }

    insertSessionGroupNameText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, clampRenameSessionValue(text, modal.maxLength || 80));
        this.setSessionGroupNameValue(next.prompt, next.cursor);
    }

    deleteSessionGroupNameChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setSessionGroupNameValue(next.prompt, next.cursor);
    }

    moveSessionGroupNameCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        this.setSessionGroupNameValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveSessionGroupNameCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        this.setSessionGroupNameValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    async confirmSessionGroupNameModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionGroupName") return;
        const title = String(modal.value || "").trim();
        if (!title) {
            this.dispatch({ type: "ui/status", text: "Group name cannot be empty" });
            return;
        }
        if (modal.mode === "rename" && modal.groupId) {
            const previousFocusRename = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocusRename) this.setFocus(previousFocusRename);
            try {
                await this.transport.updateSessionGroup(modal.groupId, { title });
                this.dispatch({ type: "ui/status", text: `Renamed group to "${title}"` });
                await this.refreshSessions().catch(() => {});
            } catch (error) {
                this.dispatch({ type: "ui/status", text: `Rename failed: ${error?.message || String(error)}` });
            }
            return;
        }
        if (typeof this.transport.createSessionGroup !== "function") {
            this.dispatch({ type: "ui/status", text: "Session grouping is not supported by this transport" });
            return;
        }
        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) this.setFocus(previousFocus);

        try {
            // No owner key: the transport/server stamps the caller's
            // principal. The UI never infers group ownership from the
            // selected sessions (owner: null is reserved for the portal
            // runtime's anonymous path).
            const group = await this.transport.createSessionGroup({
                title,
                description: `${(modal.sessionIds || []).length} grouped session${(modal.sessionIds || []).length === 1 ? "" : "s"}`,
                sessionIds: modal.sessionIds || [],
            });
            const ids = modal.sessionIds || [];
            if (ids.length === 0) {
                // An empty folder is the point — refresh so it appears, and
                // say so instead of reporting "nothing to move".
                this.dispatch({ type: "ui/status", text: `Created group "${group.title || title}"` });
                await this.refreshSessions().catch(() => {});
            } else {
                await this.moveSessionsToGroup(group.groupId, ids, { statusTitle: group.title || title });
            }
        } catch (error) {
            this.dispatch({ type: "ui/status", text: `Move failed: ${error?.message || String(error)}` });
        }
    }

    applyActiveGroupDefault(options = {}) {
        if (options && Object.prototype.hasOwnProperty.call(options, "groupId")) {
            return options;
        }
        const state = this.getState();
        const activeSession = state.sessions?.activeSessionId
            ? state.sessions.byId[state.sessions.activeSessionId]
            : null;
        // ONLY when the selected row is the folder itself. Selecting a folder
        // and pressing New is the user pointing at it; inheriting the group
        // from a selected MEMBER is not — it filed new sessions inside
        // whichever folder happened to hold the last session read, so a new
        // session appeared buried mid-list instead of at the end where the
        // sort puts an unplaced row.
        if (!activeSession?.isGroup) return options;
        const groupId = activeSession.groupId || sessionGroupIdFromRowId(activeSession.sessionId);
        return groupId ? { ...options, groupId } : options;
    }

    getActiveSession(state = this.getState()) {
        const sessionId = state.sessions?.activeSessionId;
        return sessionId ? state.sessions.byId[sessionId] || null : null;
    }



    /**
     * Opens the agent step of the new-session flow.
     *
     * This step needs a network round trip (listCreatableAgents) before it can
     * render, and it is reached from the middle of a modal chain. Callers used
     * to close the current step BEFORE awaiting it, which left the overlay
     * unmounted for the length of that fetch — the dialog visibly blinked out
     * and back on the way to the agent list.
     *
     * So nothing is dismissed until we know what replaces it: on success the
     * new modal REPLACES the open one in a single dispatch and the overlay
     * never leaves the screen; only the paths that open no modal at all close
     * it. `previousFocus` is threaded from the previous step because that step
     * is deliberately still up, so it cannot be recovered from focus state.
     */
    async openSessionAgentPicker(options = {}, previousFocusOverride = null) {
        const previousFocus = previousFocusOverride ?? this.getState().ui.focusRegion;
        const dismiss = () => {
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
        };

        let agents = [];
        try {
            agents = typeof this.transport.listCreatableAgents === "function"
                ? await this.transport.listCreatableAgents()
                : [];
        } catch (error) {
            // The previous step is deliberately still on screen. If the fetch
            // fails we own dismissing it — otherwise the flow strands on a step
            // whose Enter key has already been consumed.
            dismiss();
            this.dispatch({
                type: "ui/status",
                text: `Could not load agents: ${error?.message || error}`,
            });
            return;
        }
        const sessionPolicy = typeof this.transport.getSessionCreationPolicy === "function"
            ? this.transport.getSessionCreationPolicy()
            : null;
        const allowGeneric = sessionPolicy?.creation?.allowGeneric ?? true;

        if (!Array.isArray(agents) || agents.length === 0) {
            dismiss();
            if (!allowGeneric) {
                this.dispatch({
                    type: "ui/status",
                    text: "No user-creatable agents are available for this app",
                });
                return;
            }
            await this.createSession(options);
            return;
        }

        // The CATALOG (every agent, section-agnostic). The visible row list is
        // derived from it by buildAgentPickerItems, which is re-run whenever a
        // section is expanded or collapsed.
        const agentItems = [];
        for (const agent of agents) {
            const agentName = String(agent?.name || "").trim();
            if (!agentName) continue;
            agentItems.push({
                id: agentName,
                kind: "agent",
                agentName,
                title: formatAgentDisplayTitle(agentName, agent?.title),
                description: String(agent?.description || "").trim(),
                tools: Array.isArray(agent?.tools) ? agent.tools.filter(Boolean) : [],
                splash: typeof agent?.splash === "string" && agent.splash.trim() ? agent.splash : null,
                splashMobile: typeof agent?.splashMobile === "string" && agent.splashMobile.trim() ? agent.splashMobile : null,
                initialPrompt: typeof agent?.initialPrompt === "string" && agent.initialPrompt.trim() ? agent.initialPrompt : null,
                // Agent-package provenance (docs/proposals/agent-packages.md):
                // "mine" = my user-scope package agents; everything else
                // (baked/built-in + shared packages) groups under Shared.
                //
                // Ownership is the transport's call — it knows the viewer. An
                // admin sees OTHER users' user-scoped packages, so scope alone
                // put their agents under "My agents". A transport that does not
                // report `mine` is single-user or legacy, where user-scope does
                // mean mine.
                group: agent?.source === "package" && agent?.scope === "user" && agent?.mine !== false
                    ? "mine"
                    : "shared",
                packageName: agent?.packageName || null,
                packageTitle: agent?.packageTitle || null,
                packageSemver: agent?.packageSemver || null,
                packageScope: agent?.scope || null,
                ownerLabel: agent?.ownerLabel || null,
                startedBy: Array.isArray(agent?.startedBy) ? agent.startedBy.filter(Boolean) : [],
                // RAW: undefined means "not declared". The default is applied
                // in orderAgentsByComposition, which is the only place that
                // knows whether a creator actually resolved.
                supportsDirectStart: typeof agent?.supportsDirectStart === "boolean" ? agent.supportsDirectStart : undefined,
                builtin: agent?.source !== "package",
            });
        }
        const catalog = [
            ...agentItems.filter((item) => item.group === "shared"),
            ...agentItems.filter((item) => item.group === "mine"),
        ];
        const genericItem = allowGeneric
            ? {
                id: "__generic__",
                kind: "generic",
                group: "generic",
                title: "Generic Session",
                description: "Open-ended session with no specialized agent boundary.",
                tools: [],
                splash: null,
                splashMobile: null,
                initialPrompt: null,
                supportsDirectStart: true,
            }
            : null;

        // EVERYTHING starts closed. The dialog opens as a short menu of
        // categories — Generic, then whichever of Built-in / Shared / Yours
        // this deployment actually has — and you open the one you want. A
        // section expanded by default is a section every other user has to
        // scroll past.
        const collapsed = [
            AGENT_PICKER_BUILTIN_KEY,
            AGENT_PICKER_SHARED_KEY,
            AGENT_PICKER_MINE_KEY,
            ...new Set(catalog.filter((item) => !item.builtin).map((item) => agentPickerPackageKey(item))),
        ];
        const items = buildAgentPickerItems(catalog, collapsed, genericItem);

        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "sessionAgentPicker",
                title: "Select agent for new session",
                catalog,
                genericItem,
                collapsed,
                items,
                // Land somewhere Enter does something useful. First choice is a
                // real agent row; with none visible (no generic, no baked
                // agents, every package closed) fall back to the first CLOSED
                // package, whose Enter opens it. Landing on an open section
                // header — which findIndex's -1 used to do via Math.max — made
                // the very first keystroke collapse the whole list.
                selectedIndex: agentPickerInitialIndex(items),
                previousFocus,
                sessionOptions: options,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select an agent and press Enter" });
    }

    async openNewSessionFlow(options = {}) {
        const sessionPolicy = typeof this.transport.getSessionCreationPolicy === "function"
            ? this.transport.getSessionCreationPolicy()
            : null;
        const allowGeneric = sessionPolicy?.creation?.allowGeneric ?? true;
        if (allowGeneric) {
            await this.createSession(options);
            return;
        }
        if (typeof this.transport.listModels === "function") {
            await this.openModelPicker(options);
            return;
        }
        await this.openSessionAgentPicker(options);
    }

    // previousFocus rides along the whole chain: each step is left on screen
    // until its successor is ready (see openSessionAgentPicker), so a later
    // step cannot read the pre-modal focus back off the state.
    async openReasoningEffortPicker(modelItem, sessionOptions = {}, previousFocusOverride = null) {
        const previousFocus = previousFocusOverride ?? this.getState().ui.focusRegion;
        const supported = normalizeReasoningEfforts(modelItem?.supportedReasoningEfforts);
        const selectedEffort = sessionOptions?.reasoningEffort || resolveDefaultReasoningEffort(modelItem);
        if (!supported.length || !selectedEffort) {
            // No effort step for this model — fall through to the context-tier
            // step, which handles both the new-session and switch-model flows.
            await this.openContextTierPicker(modelItem, sessionOptions, previousFocus);
            return;
        }

        const items = supported.map((effort) => ({
            id: effort,
            effort,
            label: effort,
            isDefault: selectedEffort === effort,
        }));
        const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedEffort));
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "reasoningEffortPicker",
                title: sessionOptions?.mode === "switchModel"
                    ? `Switch reasoning for ${modelItem?.modelName || modelItem?.qualifiedName || "model"}`
                    : `Reasoning effort for ${modelItem?.modelName || modelItem?.qualifiedName || "model"}`,
                items,
                selectedIndex,
                previousFocus,
                modelItem,
                sessionOptions,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a reasoning effort and press Enter" });
    }

    async openContextTierPicker(modelItem, sessionOptions = {}, previousFocusOverride = null) {
        // Context-window tier step of the new-session flow. Only models whose
        // catalog entry declares supportedContextTiers get this picker; all
        // others skip straight to the agent picker. The preselected tier is
        // the catalog default ("default", the smaller window).
        const previousFocus = previousFocusOverride ?? this.getState().ui.focusRegion;
        const supported = normalizeContextTiers(modelItem?.supportedContextTiers);
        const selectedTier = sessionOptions?.contextTier || resolveDefaultContextTier(modelItem);
        if (!supported.length || !selectedTier) {
            // Model declares no context-window tiers — skip straight to applying
            // the switch (switch flow) or to the agent picker (new-session flow).
            if (sessionOptions?.mode === "switchModel") {
                this.dispatch({ type: "ui/modal", modal: null });
                if (previousFocus) {
                    this.setFocus(previousFocus);
                }
                await this.switchSessionModel({ ...sessionOptions, model: modelItem?.id });
                return;
            }
            await this.openSessionAgentPicker(sessionOptions, previousFocus);
            return;
        }

        const items = supported.map((tier) => ({
            id: tier,
            tier,
            tokenLimit: modelItem?.contextWindowSizes?.[tier] || null,
            label: formatContextTierLabel(tier, modelItem?.contextWindowSizes?.[tier]),
            isDefault: selectedTier === tier,
        }));
        const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedTier));
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "contextTierPicker",
                title: `Context window for ${modelItem?.modelName || modelItem?.qualifiedName || "model"}`,
                items,
                selectedIndex,
                previousFocus,
                modelItem,
                sessionOptions,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a context window and press Enter" });
    }

    /**
     * The model step of the create flow.
     *
     * What it lists is PROVIDERS, one group each, with the models their type
     * offers — so a provider an admin or a user created a minute ago is on
     * the list without anyone restarting anything, and the entry carries its
     * budget state inline ("42% of its Daily limit used", "AT ITS DAILY
     * LIMIT") so the choice is made knowing.
     *
     * An empty namespace REFUSES rather than falling back to the whole
     * catalog: a list of models nothing can pay for is a list of dead ends.
     * A deployment that has no provider operations at all — or one whose
     * provider read failed, which is not the same thing as having none — is
     * a different case and keeps exactly today's behaviour.
     */
    async openModelPicker(sessionOptions = {}) {
        if (typeof this.transport.listModels !== "function") {
            await this.openSessionAgentPicker(sessionOptions);
            return;
        }

        const models = await this.transport.listModels();
        if (!Array.isArray(models) || models.length === 0) {
            this.dispatch({ type: "ui/status", text: "No models available" });
            return;
        }

        const namespace = await this._resolveProviderNamespace();
        const built = namespace?.error
            ? { refusal: namespace.error }
            : namespace
            ? this._buildProviderPickerGroups(namespace, models, sessionOptions)
            : await this._buildCatalogPickerGroups(models, sessionOptions);
        if (built.refusal) {
            this.dispatch({ type: "ui/status", text: built.refusal });
            return;
        }
        const { items, groups, selectedIndex } = built;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "modelPicker",
                title: sessionOptions?.mode === "switchModel" ? "Switch model for session" : "Select model for new session",
                items,
                groups,
                selectedIndex,
                previousFocus: this.getState().ui.focusRegion,
                sessionOptions,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a model and press Enter" });
    }

    /**
    * The providers this viewer can spend from, with their limits and the
    * default tuples. Null means the deployment predates runtime-provider
    * APIs. Once those APIs exist, a failed namespace read is authoritative:
    * fail closed rather than offering static type names with no proven
    * credential or ownership.
     */
    async _resolveProviderNamespace() {
        if (typeof this.transport.listProviders !== "function") return null;
        try {
            const [list, status, defaults] = await Promise.all([
                this.transport.listProviders(),
                typeof this.transport.getProviderStatus === "function"
                    ? this.transport.getProviderStatus().catch(() => null)
                    : null,
                typeof this.transport.getDefaults === "function"
                    ? this.transport.getDefaults().catch(() => null)
                    : null,
            ]);
            const providers = Array.isArray(list?.providers) ? list.providers : null;
            if (!providers) return { error: "Runtime provider availability could not be verified. Refresh and try again." };
            return {
                providers,
                status: Array.isArray(status?.providers) ? status.providers : [],
                statusKnown: Array.isArray(status?.providers),
                defaults: defaults || null,
            };
        } catch {
            return { error: "Runtime provider availability could not be verified. Refresh and try again." };
        }
    }

    /**
     * One group per provider, models re-qualified under the provider's own
     * name.
     *
     * The catalog's `providerId` is the TYPE ("azure-openai"); a provider is
     * an instance of that type with a name of its own ("azure-prod"), and a
     * session runs `<provider>:<model>`. A deployment that never created a
     * second instance sees no change at all, because the seed names each
     * provider after the config entry it came from.
     */
    _buildProviderPickerGroups(namespace, models, sessionOptions) {
        const usable = namespace.providers.filter((row) => row.usableByMe !== false);
        if (usable.length === 0) {
            return {
                refusal: "No provider can pay for a session yet — add one of your own, or ask an admin for a shared one.",
            };
        }
        const modelsByType = new Map();
        for (const model of models) {
            const typeId = model?.providerId;
            if (!typeId) continue;
            if (!modelsByType.has(typeId)) modelsByType.set(typeId, []);
            modelsByType.get(typeId).push(model);
        }
        const statusByName = new Map(namespace.status.map((row) => [row.name, row]));
        const now = Date.now();
        // Your own default first, then the cluster's, then your own
        // providers, then the shared ones: what a plain Enter charges should
        // be what the deployment would have chosen anyway.
        const ranked = [...usable].sort((a, b) => {
            const rank = (row) => (row.isMyDefault === true ? 0
                : row.isClusterDefault === true ? 1
                : row.class === "personal" ? 2 : 3);
            return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
        });
        const preferredModel = sessionOptions?.model
            || namespace.defaults?.mine?.model
            || namespace.defaults?.cluster?.model
            || (typeof this.transport.getDefaultModel === "function" ? this.transport.getDefaultModel() : undefined);

        const items = [];
        const groups = ranked
            .map((provider) => {
                const room = providerPickerNote(provider, statusByName.get(provider.name) || null, now);
                // A provider with no credential cannot pay for anything. Say
                // so on the row rather than hiding it: the person who has to
                // fix it is often the one looking at the list.
                const disabledReason = provider.hasCredential === false
                    ? `${provider.name} has no credential`
                    : null;
                return {
                    providerId: provider.name,
                    providerType: provider.typeId,
                    providerClass: provider.class,
                    isClusterDefault: provider.isClusterDefault === true,
                    isMyDefault: provider.isMyDefault === true,
                    hasCredential: provider.hasCredential !== false,
                    budgetState: room.state,
                    budgetNote: room.text,
                    models: (modelsByType.get(provider.name) || modelsByType.get(provider.typeId) || []).map((model) => {
                        const qualifiedName = model.providerId === provider.name && model.qualifiedName
                            ? model.qualifiedName
                            : `${provider.name}:${model.modelName}`;
                        const modelDisabledReason = disabledReason
                            || (model.credentialAvailable === false
                                ? `${provider.name} has no usable credential or endpoint`
                                : null);
                        const item = {
                            id: qualifiedName,
                            qualifiedName,
                            modelName: model.modelName || qualifiedName,
                            providerId: provider.name,
                            providerType: provider.typeId,
                            providerClass: provider.class,
                            description: model.description || "",
                            cost: model.cost || null,
                            supportedReasoningEfforts: normalizeReasoningEfforts(model.supportedReasoningEfforts),
                            defaultReasoningEffort: model.defaultReasoningEffort || null,
                            supportedContextTiers: normalizeContextTiers(model.supportedContextTiers),
                            defaultContextTier: model.defaultContextTier || null,
                            contextWindowSizes: model.contextWindowSizes || null,
                            isDefault: preferredModel === qualifiedName,
                            budgetState: room.state,
                            budgetNote: room.text,
                            disabledReason: modelDisabledReason,
                            disabled: Boolean(modelDisabledReason),
                        };
                        items.push(item);
                        return item;
                    }),
                };
            })
            .filter((group) => group.models.length > 0);

        if (items.length === 0) {
            return { refusal: "No provider in your namespace offers a model to run." };
        }
        return { items, groups, selectedIndex: pickerSelectedIndex(items, preferredModel) };
    }

    /**
     * The catalog list, exactly as it was before providers existed. Kept for
    * deployments whose server predates the provider operations. Provider API
    * failures never take this path.
     */
    async _buildCatalogPickerGroups(models, sessionOptions) {
        const defaultModel = typeof this.transport.getDefaultModel === "function"
            ? this.transport.getDefaultModel()
            : undefined;
        const groupedModels = typeof this.transport.getModelsByProvider === "function"
            ? this.transport.getModelsByProvider()
            : groupModelsByProvider(models);
        // Whether the current user has a per-user GitHub Copilot key:
        // true/false when known, null when the transport can't tell (then
        // no model gets disabled — never lock models out on a guess).
        const ghcpUserKeySet = await this._resolveGhcpUserKeySet();
        const items = [];
        const groups = groupedModels
            .map((group) => ({
                providerId: group.providerId,
                providerType: group.type || group.providerType,
                models: (group.models || []).map((model) => {
                    const providerType = model.providerType || group.type || group.providerType;
                    // Copilot models with no worker-level token are unusable
                    // for users who haven't stored their own GitHub key.
                    const ghcpKeyMissing = providerType === "github"
                        && model.credentialAvailable === false
                        && ghcpUserKeySet === false;
                    const item = {
                        id: model.qualifiedName,
                        qualifiedName: model.qualifiedName,
                        modelName: model.modelName || model.qualifiedName,
                        providerId: model.providerId || group.providerId,
                        providerType,
                        description: model.description || "",
                        cost: model.cost || null,
                        supportedReasoningEfforts: normalizeReasoningEfforts(model.supportedReasoningEfforts),
                        defaultReasoningEffort: model.defaultReasoningEffort || null,
                        supportedContextTiers: normalizeContextTiers(model.supportedContextTiers),
                        defaultContextTier: model.defaultContextTier || null,
                        contextWindowSizes: model.contextWindowSizes || null,
                        isDefault: defaultModel === model.qualifiedName,
                        ghcpKeyMissing,
                        disabledReason: ghcpKeyMissing ? "needs GitHub key" : null,
                        disabled: ghcpKeyMissing,
                    };
                    items.push(item);
                    return item;
                }),
            }))
            .filter((group) => group.models.length > 0);

        return {
            items,
            groups,
            selectedIndex: pickerSelectedIndex(items, sessionOptions?.model || defaultModel),
        };
    }

    async _resolveGhcpUserKeySet() {
        // Freshest signal first: the profile the Admin console loaded in this
        // session (updates immediately after the user saves a key there).
        const adminProfile = this.getState().admin?.profile;
        if (typeof adminProfile?.githubCopilotKeySet === "boolean") {
            return adminProfile.githubCopilotKeySet;
        }
        if (typeof this.transport.getCurrentUserProfile !== "function") return null;
        try {
            const profile = await this.transport.getCurrentUserProfile();
            if (profile && typeof profile.githubCopilotKeySet === "boolean") {
                return profile.githubCopilotKeySet;
            }
            // Profile fetch succeeded but no stored flag — a user with no
            // profile row has no key.
            return false;
        } catch {
            return null;
        }
    }

    async openSwitchModelPicker(onApplied = null) {
        // Callers (e.g. the portal Manage modal) can be notified when a switch
        // is actually applied — distinct from cancelling the picker — so they
        // can close/reopen their own chrome accordingly.
        this._onSwitchModelApplied = typeof onApplied === "function" ? onApplied : null;
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        const session = sessionId ? state.sessions.byId[sessionId] || null : null;
        if (!session || session.isGroup) {
            this._onSwitchModelApplied = null;
            this.dispatch({ type: "ui/status", text: "Select a session before switching model" });
            return;
        }
        if (typeof this.transport.setSessionModel !== "function") {
            this._onSwitchModelApplied = null;
            this.dispatch({ type: "ui/status", text: "Model switching is not supported by this transport" });
            return;
        }
        await this.openModelPicker({
            mode: "switchModel",
            sessionId,
            model: session.model || undefined,
            reasoningEffort: session.reasoningEffort || undefined,
        });
    }

    async switchSessionModel(options = {}) {
        const sessionId = options.sessionId || this.getState().sessions.activeSessionId;
        const model = String(options.model || "").trim();
        if (!sessionId || !model) {
            this.dispatch({ type: "ui/status", text: "Select a model before switching" });
            return;
        }
        if (typeof this.transport.setSessionModel !== "function") {
            this.dispatch({ type: "ui/status", text: "Model switching is not supported by this transport" });
            return;
        }
        await this.transport.setSessionModel(sessionId, {
            model,
            ...("reasoningEffort" in options ? { reasoningEffort: options.reasoningEffort ?? null } : {}),
            ...("contextTier" in options ? { contextTier: options.contextTier ?? null } : {}),
            source: "ui",
        });
        const modelLabel = options.reasoningEffort ? `${model}:${options.reasoningEffort}` : model;
        const tierSuffix = options.contextTier ? ` · ${CONTEXT_TIER_LABELS[options.contextTier] || options.contextTier}` : "";
        this.dispatch({ type: "ui/status", text: `Next turn will use ${modelLabel}${tierSuffix}` });
        await this.refreshSessions();
        // Notify a Manage-modal-style caller that the switch was applied (vs
        // cancelled), so it can close rather than reopen.
        const onApplied = this._onSwitchModelApplied;
        this._onSwitchModelApplied = null;
        if (typeof onApplied === "function") onApplied();
    }

    openHelpModal() {
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "help",
                title: "Keybindings",
                selectedIndex: 0,
                previousFocus: this.getState().ui.focusRegion,
            },
        });
        this.dispatch({ type: "ui/status", text: "Keybindings — ? or Esc to close" });
    }

    openThemePicker() {
        // listThemes() is already ordered by group then label, so the picker
        // renders a heading wherever `group` changes rather than re-sorting.
        // The list itself stays FLAT: headings are drawn between rows, never
        // as rows, so selectedIndex keeps addressing themes and arrow-key
        // navigation never lands on a heading.
        const themes = listThemes().map((theme) => ({
            id: theme.id,
            label: theme.label,
            description: theme.description,
            group: theme.group,
            page: theme.page,
            terminal: theme.terminal,
            tui: theme.tui,
        }));
        if (themes.length === 0) {
            this.dispatch({ type: "ui/status", text: "No themes available" });
            return;
        }

        const currentThemeId = this.getState().ui.themeId;
        const selectedIndex = Math.max(0, themes.findIndex((theme) => theme.id === currentThemeId));
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "themePicker",
                title: "Theme Picker",
                items: themes,
                selectedIndex,
                previousFocus: this.getState().ui.focusRegion,
                currentThemeId,
            },
        });
        this.dispatch({ type: "ui/status", text: "Select a theme and press Enter" });
    }

    getPromptDraftSessionId() {
        const promptAttachmentSessionId = this.getPromptAttachments()[0]?.sessionId || null;
        return promptAttachmentSessionId || this.getState().sessions.activeSessionId || null;
    }

    openArtifactUploadModal() {
        if (typeof this.transport.uploadArtifactFromPath !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact upload is not supported by this transport" });
            return;
        }

        const state = this.getState();
        const sessionId = this.getPromptDraftSessionId();
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "artifactUpload",
                title: sessionId
                    ? `Upload Artifact (${shortSessionIdValue(sessionId)})`
                    : "Upload Artifact",
                sessionId,
                previousFocus: state.ui.focusRegion,
                value: "",
                cursorIndex: 0,
            },
        });
        this.dispatch({
            type: "ui/status",
            text: sessionId
                ? "Paste a local file path and press Enter to upload it into this session's artifacts"
                : "Paste a local file path and press Enter to upload it; a new session will be created if needed",
        });
    }

    updateArtifactUploadModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({
            type: "ui/modal",
            modal: {
                ...modal,
                ...nextModal,
            },
        });
        return this.getState().ui.modal;
    }

    setArtifactUploadValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const safeValue = String(value || "").replace(/\r?\n/g, "");
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateArtifactUploadModal({
            value: safeValue,
            cursorIndex: safeCursor,
        });
    }

    insertArtifactUploadText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, String(text || "").replace(/\r?\n/g, ""));
        this.setArtifactUploadValue(next.prompt, next.cursor);
    }

    deleteArtifactUploadChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setArtifactUploadValue(next.prompt, next.cursor);
    }

    moveArtifactUploadCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        this.setArtifactUploadValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveArtifactUploadCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        this.setArtifactUploadValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    async ensurePromptAttachmentSessionId() {
        const existingAttachmentSessionId = this.getPromptAttachments()[0]?.sessionId || null;
        if (existingAttachmentSessionId) {
            if (this.getState().sessions.activeSessionId !== existingAttachmentSessionId) {
                await this.loadSession(existingAttachmentSessionId);
            }
            return existingAttachmentSessionId;
        }

        const activeSessionId = this.getState().sessions.activeSessionId;
        if (activeSessionId) return activeSessionId;

        const created = await this.createSession({});
        if (!created?.sessionId) throw new Error("Create a session before attaching files");
        return created.sessionId;
    }

    /**
     * Reveal an artifact in the Files tab with its preview loaded.
     *
     * The entry point for artifact links in the chat transcript: the chat only
     * ever offered "download", which is the wrong verb for a patch you want to
     * READ. Switches the inspector to Files, selects the artifact, and warms
     * the preview so the pane is populated by the time it renders.
     */
    async revealArtifact(sessionId, filename, {
        force = true,
        fullscreen = false,
        pane = false,
    } = {}) {
        const resolvedSessionId = sessionId || this.getState().sessions.activeSessionId;
        const name = String(filename || "").trim();
        if (!resolvedSessionId || !name) return false;

        // Capture the list's current selection BEFORE we move it, so backing
        // out of a chat-opened preview leaves the artifact list untouched.
        this.dispatch({
            type: "files/previewOrigin",
            origin: "chat",
            restoreArtifactId: this.getState().files.selectedArtifactId || null,
        });

        if (this.getState().sessions.activeSessionId !== resolvedSessionId) {
            await this.loadSession(resolvedSessionId).catch(() => null);
        }
        // The reader REPLACES the inspector, so it has no business changing
        // which inspector tab is selected. Switching to Files here meant that
        // opening an artifact from a session you were watching on the Sequence
        // tab silently reassigned that tab, and ✕ dropped you on a file list
        // you never opened. Leaving it alone makes ✕ restore the tab for free,
        // with no state to capture. The non-pane paths still need Files,
        // because there the inspector IS the preview.
        if (!pane) this.dispatch({ type: "ui/inspectorTab", inspectorTab: "files" });
        // The takeover pane is its own focus surface and, unlike the inspector,
        // it is what the user is looking at — so it must NOT steal focus to the
        // artifact list underneath. Chat keeps focus, which is the point: you
        // followed a link from the transcript and should still be able to type.
        if (pane) {
            // Whether the column was already collapsed is read HERE rather than
            // taken from the caller, so every entry point — a chat card, a deep
            // link, an agent's show_artifact — gets the same answer.
            //
            // And if it WAS collapsed, the column has to be opened: rendering
            // the reader into a zero-width track produced a pane that existed
            // in the DOM, reported itself open, and could not be seen. Closing
            // collapses it again, so the detour is invisible.
            const wasHidden = Boolean(this.getCurrentLayout()?.rightHidden);
            if (wasHidden) this.expandRightColumn();
            this.dispatch({ type: "files/pane", open: true, restoresToHidden: wasHidden });
        } else {
            // Focus the inspector, not just the tab. On desktop this makes j/k
            // drive the artifact list immediately; on mobile the visible pane is
            // derived from focusRegion, so without this the preview would open on
            // a pane the user cannot see.
            this.setFocus("inspector");
        }
        await this.ensureFilesForSession(resolvedSessionId, { force }).catch(() => null);
        this.dispatch({ type: "files/select", sessionId: resolvedSessionId, filename: name });
        await this.ensureFilePreview(resolvedSessionId, name, { force }).catch(() => null);
        if (fullscreen) this.dispatch({ type: "files/fullscreen", fullscreen: true });
        return true;
    }

    /**
     * Close the artifact takeover pane, restoring the right column.
     *
     * Restores the inspector/activity split it replaced — unless the column was
     * already collapsed when the pane opened, in which case it collapses again.
     * Opening a reader must not become a way to un-hide panes the user had
     * deliberately resized away.
     */
    async closeArtifactPane() {
        const restoresToHidden = this.getState().files.paneRestoresToHidden;
        this.dispatch({ type: "files/pane", open: false });
        this.dispatch({ type: "files/fullscreen", fullscreen: false });
        // Selection is deliberately left alone: the artifact stays selected in
        // the Files list, so reopening the column shows what you were reading
        // rather than an empty preview.
        this.dispatch({ type: "files/previewOrigin", origin: null });
        if (restoresToHidden) this.collapseRightColumn();
        this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.CHAT });
        return { collapsedRightColumn: Boolean(restoresToHidden) };
    }

    /**
     * Drive the left/right split far enough right that the layout's own
     * collapse rule hides the right column.
     *
     * Expressed as a paneAdjust rather than a new "hidden" flag so there stays
     * exactly one source of truth for column width — the same number the
     * resizer writes. A second flag would let the two disagree.
     */
    /** Return the left/right split to its default, un-collapsing the column. */
    expandRightColumn() {
        this.dispatch({ type: "ui/paneAdjust", paneAdjust: 0 });
        const nextLayout = this.getCurrentLayout({ paneAdjust: 0 });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) this.setFocus(safeFocus);
    }

    collapseRightColumn() {
        const layoutState = this.getState().ui.layout || {};
        const totalWidth = layoutState.viewportWidth ?? 120;
        const baseLeftWidth = Math.floor(totalWidth * DEFAULT_LEFT_PANE_RATIO);
        // One past the threshold: `<=` collapses, so land strictly inside it.
        const paneAdjust = totalWidth - COLLAPSE_RIGHT_THRESHOLD - baseLeftWidth;
        this.dispatch({ type: "ui/paneAdjust", paneAdjust });
        const nextLayout = this.getCurrentLayout({ paneAdjust });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) this.setFocus(safeFocus);
    }

    /**
     * Leave the artifact preview, returning wherever the user came FROM.
     *
     * A chat-opened preview backs out to the chat pane and restores the list's
     * previous selection — following a link from the transcript must not
     * reorganize the Files tab behind the user's back. A list-opened preview
     * just drops out of full screen and stays on the list.
     */
    async closeArtifactPreview() {
        const state = this.getState();
        const origin = state.files.previewOrigin;
        this.dispatch({ type: "files/fullscreen", fullscreen: false });

        if (origin !== "chat") {
            this.dispatch({ type: "files/previewOrigin", origin: null });
            this.setFocus(FOCUS_REGIONS.INSPECTOR);
            return;
        }

        const restoreId = state.files.restoreArtifactId;
        if (restoreId) {
            const slash = String(restoreId).indexOf("/");
            if (slash > 0) {
                this.dispatch({
                    type: "files/select",
                    sessionId: restoreId.slice(0, slash),
                    filename: restoreId.slice(slash + 1),
                });
            }
        } else {
            this.dispatch({ type: "files/select", sessionId: null, filename: null });
        }
        this.dispatch({ type: "files/previewOrigin", origin: null });
        // Dispatch the focus DIRECTLY rather than via setFocus: that runs the
        // region through normalizeFocusRegion, which falls back to order[0]
        // when the region is missing from the current layout's focus order —
        // so "chat" was being clamped to the inspector and back-from-chat
        // landed on the artifact list instead of the transcript.
        this.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.CHAT });
    }

    /**
     * Step the preview to the next/previous artifact. Never wraps.
     *
     * A chat-opened preview walks the CONVERSATION order — the order the work
     * happened in — while a list-opened one walks the Files list order, which
     * is sorted for browsing. Same buttons, two sequences, chosen by origin.
     */
    async stepArtifactPreview(delta) {
        const state = this.getState();
        if (state.files.previewOrigin !== "chat") {
            await this.moveFileSelection(delta);
            return;
        }
        const ordered = selectChatOrderedArtifactIds(state);
        if (ordered.length === 0) {
            await this.moveFileSelection(delta);
            return;
        }
        const currentIndex = ordered.indexOf(state.files.selectedArtifactId);
        // Unknown current position: start from whichever end we are heading in
        // from, rather than silently doing nothing.
        const from = currentIndex >= 0 ? currentIndex : (delta > 0 ? -1 : ordered.length);
        const nextIndex = from + (delta > 0 ? 1 : -1);
        if (nextIndex < 0 || nextIndex >= ordered.length) return;   // no wraparound
        const nextId = ordered[nextIndex];
        const slash = nextId.indexOf("/");
        if (slash <= 0) return;
        const sessionId = nextId.slice(0, slash);
        const filename = nextId.slice(slash + 1);
        this.dispatch({ type: "files/select", sessionId, filename });
        await this.ensureFilePreview(sessionId, filename).catch(() => {});
    }

    /** Can the preview step in this direction? Drives arrow disabled state. */
    canStepArtifactPreview(delta) {
        const state = this.getState();
        const ordered = state.files.previewOrigin === "chat"
            ? selectChatOrderedArtifactIds(state)
            : selectFileBrowserItems(state).map((item) => item.id);
        if (ordered.length === 0) return false;
        const i = ordered.indexOf(state.files.selectedArtifactId);
        if (i < 0) return true;
        return delta > 0 ? i < ordered.length - 1 : i > 0;
    }

    async finalizeArtifactUpload(upload, { sessionId = null, suppressStatus = false } = {}) {
        const resolvedSessionId = sessionId || upload?.sessionId || await this.ensurePromptAttachmentSessionId();
        if (!resolvedSessionId || !upload?.filename) {
            throw new Error("Upload did not return a session id and filename");
        }

        if (this.getState().sessions.activeSessionId !== resolvedSessionId) {
            await this.loadSession(resolvedSessionId);
        }

        await this.ensureFilesForSession(resolvedSessionId, { force: true }).catch(() => null);
        this.dispatch({
            type: "files/select",
            sessionId: resolvedSessionId,
            filename: upload.filename,
        });
        await this.ensureFilePreview(resolvedSessionId, upload.filename, { force: true }).catch(() => null);

        if (!suppressStatus) {
            this.dispatch({
                type: "ui/status",
                text: `Uploaded ${upload.filename}`,
            });
        }

        return {
            sessionId: resolvedSessionId,
            filename: upload.filename,
        };
    }

    async applyUploadedPromptAttachment(upload, { sessionId = null, suppressStatus = false } = {}) {
        const resolvedSessionId = sessionId || upload?.sessionId || await this.ensurePromptAttachmentSessionId();
        if (!resolvedSessionId || !upload?.filename) {
            throw new Error("Upload did not return a session id and filename");
        }

        const token = buildPromptAttachmentToken(upload.filename);
        const currentPrompt = this.getState().ui.prompt;
        const currentCursor = this.getState().ui.promptCursor;
        const previousAttachments = this.getPromptAttachments();
        const existingAttachmentIndex = previousAttachments.findIndex((attachment) => (
            attachment?.sessionId === resolvedSessionId
            && attachment?.filename === upload.filename
        ));

        if (this.getState().sessions.activeSessionId !== resolvedSessionId) {
            await this.loadSession(resolvedSessionId);
        }

        if (existingAttachmentIndex === -1 || !currentPrompt.includes(previousAttachments[existingAttachmentIndex]?.token || token)) {
            const insertion = insertPromptTextAtCursor(currentPrompt, currentCursor, `${token} `);
            this.setPrompt(insertion.prompt, insertion.cursor);
        }

        const nextAttachments = existingAttachmentIndex >= 0
            ? previousAttachments.map((attachment, index) => (index === existingAttachmentIndex
                ? {
                    ...attachment,
                    sessionId: resolvedSessionId,
                    filename: upload.filename,
                    resolvedPath: upload.resolvedPath || upload.localPath || upload.filename,
                    sizeBytes: upload.sizeBytes,
                    token,
                }
                : attachment))
            : [
                ...previousAttachments,
                {
                    id: `${resolvedSessionId}/${upload.filename}`,
                    sessionId: resolvedSessionId,
                    filename: upload.filename,
                    resolvedPath: upload.resolvedPath || upload.localPath || upload.filename,
                    sizeBytes: upload.sizeBytes,
                    token,
                },
            ];
        this.setPromptAttachments(nextAttachments);

        await this.ensureFilesForSession(resolvedSessionId, { force: true }).catch(() => null);
        this.dispatch({
            type: "files/select",
            sessionId: resolvedSessionId,
            filename: upload.filename,
        });
        if (this.getState().ui.inspectorTab === "files") {
            await this.ensureFilePreview(resolvedSessionId, upload.filename, { force: true }).catch(() => null);
        }

        this.setFocus(FOCUS_REGIONS.PROMPT);
        if (!suppressStatus) {
            this.dispatch({
                type: "ui/status",
                text: existingAttachmentIndex >= 0
                    ? `Re-attached ${upload.filename}`
                    : `Attached ${upload.filename}`,
            });
        }

        return {
            sessionId: resolvedSessionId,
            existingAttachmentIndex,
            token,
        };
    }

    async uploadArtifactFiles(files = [], { sessionId = null } = {}) {
        const fileList = Array.isArray(files)
            ? files.filter((file) => file && typeof file.name === "string")
            : [];
        if (fileList.length === 0) {
            this.dispatch({ type: "ui/status", text: "No files selected" });
            return [];
        }
        if (typeof this.transport.uploadArtifactFromFile !== "function") {
            this.dispatch({ type: "ui/status", text: "Browser file uploads are not supported by this transport" });
            return [];
        }

        this.dispatch({
            type: "ui/status",
            text: fileList.length === 1
                ? `Uploading ${fileList[0].name}...`
                : `Uploading ${fileList.length} artifact files...`,
        });

        const resolvedSessionId = sessionId || await this.ensurePromptAttachmentSessionId();
        const uploads = [];
        let failures = 0;
        let lastError = null;

        for (const file of fileList) {
            try {
                const upload = await this.transport.uploadArtifactFromFile(resolvedSessionId, file);
                uploads.push(upload);
                await this.finalizeArtifactUpload(upload, { sessionId: resolvedSessionId, suppressStatus: true });
            } catch (error) {
                failures += 1;
                lastError = error;
            }
        }

        if (uploads.length > 0) {
            this.dispatch({
                type: "ui/status",
                text: failures > 0
                    ? `Uploaded ${uploads.length}/${fileList.length} file(s); last error: ${lastError?.message || String(lastError)}`
                    : uploads.length === 1
                        ? `Uploaded ${uploads[0].filename}`
                        : `Uploaded ${uploads.length} files`,
            });
        } else if (lastError) {
            this.dispatch({
                type: "ui/status",
                text: `Upload failed: ${lastError?.message || String(lastError)}`,
            });
        }

        return uploads;
    }

    async uploadPromptAttachmentFiles(files = []) {
        return this.uploadArtifactFiles(files);
    }

    async confirmArtifactUploadModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "artifactUpload") return;
        const filePath = String(modal.value || "").trim();
        if (!filePath) {
            this.dispatch({ type: "ui/status", text: "File path cannot be empty" });
            return;
        }
        if (typeof this.transport.uploadArtifactFromPath !== "function") {
            this.dispatch({ type: "ui/status", text: "Artifact upload is not supported by this transport" });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: "Uploading artifact...",
        });

        try {
            const sessionId = modal.sessionId || await this.ensurePromptAttachmentSessionId();
            const upload = await this.transport.uploadArtifactFromPath(sessionId, filePath);
            const result = await this.finalizeArtifactUpload(upload, { sessionId, suppressStatus: true });
            this.dispatch({ type: "ui/modal", modal: null });
            // TUI attach-by-path: an uploaded raster image is also staged as a
            // prompt attachment so the next message shows it to the model —
            // same send path as the portal's paste/drop chips.
            if (this.stageUploadedImageAttachment(result, sessionId)) {
                this.dispatch({
                    type: "ui/status",
                    text: `Uploaded ${result.filename} — attached to your next message`,
                });
                return;
            }
            this.dispatch({
                type: "ui/status",
                text: `Uploaded ${result.filename}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Upload failed: ${error?.message || String(error)}`,
            });
        }
    }

    openRenameSessionModal() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }

        const session = state.sessions.byId[sessionId];
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System session titles are fixed" });
            return;
        }

        const value = getRenameSessionEditableTitle(session);
        const agentTitlePrefix = getRenameSessionPrefix(session);
        const maxLength = getRenameSessionMaxLength(session);
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "renameSession",
                // A group row's id is synthetic, so showing its short form
                // reads as a stray hex string rather than an identifier.
                title: session.isGroup ? "Rename folder" : `Rename (${shortSessionIdValue(sessionId)})`,
                sessionId,
                previousFocus: state.ui.focusRegion,
                value,
                cursorIndex: value.length,
                agentTitlePrefix,
                currentTitle: String(session.title || "").trim(),
                maxLength,
                // Folders share this modal but not its caveats: a group has no
                // agent and no LLM-generated title, so the selector suppresses
                // the auto-title warning for them.
                isGroup: Boolean(session.isGroup),
            },
        });
        this.dispatch({
            type: "ui/status",
            text: session.isGroup
                ? "Type a new folder name and press Enter to save"
                : agentTitlePrefix
                    ? `Rename title for ${agentTitlePrefix}; the agent-name prefix stays fixed`
                    : "Type a new session title and press Enter to save",
        });
    }

    /**
     * Open the Terminate/Restart picker for the active session. The picker is
     * a tiny three-button modal: Mark Completed / Cancel / Delete for ordinary
     * sessions, or Complete & Restart / Terminate & Restart / Hard Delete &
     * Restart for system sessions. Each choice closes the picker and dispatches
     * the corresponding action command, which itself opens the existing
     * per-action confirm modal. Provides a mobile-friendly entry point to
     * terminal actions that are otherwise only reachable via keyboard shortcuts.
     */
    async openTerminatePickerModal() {
        const state = this.getState();
        const selectedIds = Array.isArray(state.sessions.selectedIds) ? state.sessions.selectedIds : [];
        if (state.sessions.selectMode && selectedIds.length >= 1) {
            const eligible = this.getBulkSelectedSessionActions(state).eligible;
            if (eligible.length === 0) {
                this.dispatch({ type: "ui/status", text: "No selected sessions can be terminated" });
                return;
            }
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "terminatePicker",
                    title: "Terminate Selected Sessions",
                    previousFocus: state.ui.focusRegion,
                    bulkCount: eligible.length,
                    skippedCount: selectedIds.length - eligible.length,
                    selectedIds: eligible.map((session) => session.sessionId),
                },
            });
            this.dispatch({ type: "ui/status", text: "Choose what to do with the selected sessions" });
            return;
        }
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        const session = state.sessions.byId[sessionId];
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            const label = String(session.title || session.agentId || sessionId.slice(0, 8)).trim();
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "terminatePicker",
                    title: "Restart System Session",
                    sessionId,
                    previousFocus: state.ui.focusRegion,
                    sessionTitle: label,
                    state: String(session.state || "").trim(),
                    systemRestart: true,
                },
            });
            this.dispatch({ type: "ui/status", text: "Choose how to restart the system session" });
            return;
        }
        if (session.isGroup) {
            this.dispatch({ type: "ui/status", text: "Groups are containers; manage sessions individually." });
            return;
        }
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "terminatePicker",
                title: `Terminate (${shortSessionIdValue(sessionId)})`,
                sessionId,
                previousFocus: state.ui.focusRegion,
                sessionTitle: String(session.title || "").trim(),
                state: String(session.state || "").trim(),
                // Regenerate is NOT a terminal disposition — it lives in
                // Manage session (General) where the rest of the "change this
                // session" actions are. This picker is purely terminal.
                canRegenerate: false,
            },
        });
    }

    /**
     * Pick one of the three terminate actions. Closes the picker and
     * dispatches the corresponding action command, which will then
     * open the existing per-action confirm modal.
     */
    async pickTerminateAction(action) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "terminatePicker") return;
        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) this.setFocus(previousFocus);
        if (action === "complete") {
            await this.completeActiveSession();
        } else if (action === "cancel") {
            await this.cancelActiveSession();
        } else if (action === "delete") {
            await this.deleteActiveSession();
        } else if (action === "regenerate") {
            await this.regenerateActiveSession();
        }
    }

    getBulkSelectedSessionActions(state = this.getState()) {
        const selectedIds = Array.isArray(state.sessions.selectedIds) ? state.sessions.selectedIds : [];
        const uniqueIds = [...new Set(selectedIds.map((id) => String(id || "").trim()).filter(Boolean))];
        const selected = uniqueIds
            .map((id) => state.sessions.byId[id])
            .filter(Boolean);
        const eligible = selected.filter((session) => !session.isSystem && !session.isGroup);
        return {
            selected,
            eligible,
            skippedCount: selected.length - eligible.length,
        };
    }

    updateRenameSessionModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({
            type: "ui/modal",
            modal: {
                ...modal,
                ...nextModal,
            },
        });
        return this.getState().ui.modal;
    }

    setRenameSessionValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const safeValue = clampRenameSessionValue(value, modal.maxLength);
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateRenameSessionModal({
            value: safeValue,
            cursorIndex: safeCursor,
        });
    }

    insertRenameSessionText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, clampRenameSessionValue(text, modal.maxLength));
        this.setRenameSessionValue(next.prompt, next.cursor);
    }

    deleteRenameSessionChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setRenameSessionValue(next.prompt, next.cursor);
    }

    moveRenameSessionCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        this.setRenameSessionValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveRenameSessionCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        this.setRenameSessionValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    async confirmRenameSessionModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "renameSession") return;
        const sessionId = modal.sessionId;
        if (!sessionId) return;

        const requestedTitle = String(modal.value || "").trim();
        if (!requestedTitle) {
            this.dispatch({ type: "ui/status", text: "Title cannot be empty" });
            return;
        }

        // Group rows live under the same Rename action but are renamed via
        // the session-group API rather than renameSession (which only
        // accepts real session ids).
        const session = this.getState().sessions.byId[sessionId];
        const groupId = session?.isGroup
            ? (session.groupId || sessionGroupIdFromRowId(sessionId))
            : null;
        if (groupId) {
            if (typeof this.transport.updateSessionGroup !== "function") {
                this.dispatch({ type: "ui/status", text: "Group renaming is not supported by this transport" });
                return;
            }
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            this.dispatch({ type: "ui/status", text: `Renaming group ${groupId.slice(0, 8)}...` });
            try {
                await this.transport.updateSessionGroup(groupId, { title: requestedTitle });
                await this.refreshSessions();
                this.dispatch({ type: "ui/status", text: `Renamed group ${requestedTitle}` });
            } catch (error) {
                this.dispatch({
                    type: "ui/status",
                    text: `Rename failed: ${error?.message || String(error)}`,
                });
            }
            return;
        }

        if (typeof this.transport.renameSession !== "function") {
            this.dispatch({ type: "ui/status", text: "Session renaming is not supported by this transport" });
            return;
        }

        const previousFocus = modal.previousFocus;
        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) {
            this.setFocus(previousFocus);
        }

        this.dispatch({
            type: "ui/status",
            text: `Renaming ${shortSessionIdValue(sessionId)}...`,
        });

        try {
            await this.transport.renameSession(sessionId, requestedTitle);
            await this.refreshSessions();
            this.scheduleSessionDetailSync(sessionId, 100);
            this.dispatch({
                type: "ui/status",
                text: `Renamed ${shortSessionIdValue(sessionId)}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Rename failed: ${error?.message || String(error)}`,
            });
        }
    }

    /**
     * Cycle the active session's general visibility:
     * private → shared_read → shared_write → private. Visibility is a
     * per-session property, so system sessions and group rows are refused.
     */
    async cycleSessionVisibility() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        const session = sessionId ? state.sessions.byId[sessionId] : null;
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System sessions are always private" });
            return;
        }
        if (session.isGroup) {
            this.dispatch({ type: "ui/status", text: "Groups don't have visibility" });
            return;
        }
        if (typeof this.transport.setSessionVisibility !== "function") {
            this.dispatch({ type: "ui/status", text: "Not supported by this transport" });
            return;
        }
        const next = cycleValue(
            ["private", "shared_read", "shared_write"],
            session.visibility || "private",
            1,
        );
        try {
            await this.transport.setSessionVisibility(sessionId, next);
            await this.refreshSessions();
            this.dispatch({ type: "ui/status", text: `Visibility → ${next}` });
        } catch (error) {
            this.dispatch({ type: "ui/status", text: error?.message || String(error) });
        }
    }

    /**
     * Open the Share modal for the active session: shows the general
     * visibility plus the per-person grant list, with a single input line
     * for edits — `name [r|w]` grants, `-name` revokes. The current grants
     * are loaded up front so the modal (and revoke matching) can render
     * them without another round trip.
     */
    async openShareSessionModal() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        const session = sessionId ? state.sessions.byId[sessionId] : null;
        if (!session) {
            this.dispatch({ type: "ui/status", text: "No session selected" });
            return;
        }
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System sessions are always private" });
            return;
        }
        if (session.isGroup) {
            this.dispatch({ type: "ui/status", text: "Groups can't be shared" });
            return;
        }
        if (typeof this.transport.listSessionShares !== "function") {
            this.dispatch({ type: "ui/status", text: "Session sharing is not supported by this transport" });
            return;
        }
        let shares;
        try {
            shares = await this.transport.listSessionShares(sessionId);
        } catch (error) {
            this.dispatch({ type: "ui/status", text: error?.message || String(error) });
            return;
        }
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "shareSession",
                title: `Share (${shortSessionIdValue(sessionId)})`,
                sessionId,
                previousFocus: state.ui.focusRegion,
                value: "",
                cursorIndex: 0,
                shares: Array.isArray(shares) ? shares : [],
                visibility: session.visibility || "private",
            },
        });
        this.dispatch({ type: "ui/status", text: "name [r|w] grants · -name revokes · Enter apply" });
    }

    updateShareSessionModal(updater) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return null;
        const nextModal = typeof updater === "function" ? updater(modal) : updater;
        if (!nextModal) return null;
        this.dispatch({ type: "ui/modal", modal: { ...modal, ...nextModal } });
        return this.getState().ui.modal;
    }

    setShareSessionValue(value, cursorIndex = String(value || "").length) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        const safeValue = clampRenameSessionValue(value, 120);
        const safeCursor = clampPromptCursor(safeValue, cursorIndex);
        this.updateShareSessionModal({ value: safeValue, cursorIndex: safeCursor });
    }

    insertShareSessionText(text) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        const next = insertPromptTextAtCursor(modal.value || "", modal.cursorIndex || 0, clampRenameSessionValue(text, 120));
        this.setShareSessionValue(next.prompt, next.cursor);
    }

    deleteShareSessionChar() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        const next = deletePromptCharBackward(modal.value || "", modal.cursorIndex || 0);
        this.setShareSessionValue(next.prompt, next.cursor);
    }

    moveShareSessionCursor(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        this.setShareSessionValue(modal.value || "", clampPromptCursor(modal.value || "", (modal.cursorIndex || 0) + delta));
    }

    moveShareSessionCursorToBoundary(kind) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        this.setShareSessionValue(modal.value || "", kind === "start" ? 0 : String(modal.value || "").length);
    }

    /**
     * Apply the typed share command. Empty input just closes the modal.
     * `-name` (or `revoke name`) revokes an existing grant; anything else
     * grants, with an optional trailing r/read/w/write access token
     * (default read). The grantee is resolved against the member directory
     * when the transport exposes it; unmatched text falls back to a raw
     * subject so a grant can target someone who has never signed in —
     * an email-keyed grant binds at their first sign-in.
     */
    async confirmShareSessionModal() {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "shareSession") return;
        const sessionId = modal.sessionId;
        if (!sessionId) return;

        const raw = String(modal.value || "").trim();
        const previousFocus = modal.previousFocus;
        if (!raw) {
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            return;
        }

        // Revoke: `-name` or `revoke name` targets an existing grant by
        // subject, email, or display name (case-insensitive).
        const revokeWho = raw.startsWith("-")
            ? raw.slice(1).trim()
            : (raw.toLowerCase().startsWith("revoke ") ? raw.slice("revoke ".length).trim() : null);
        if (revokeWho !== null) {
            const needle = revokeWho.toLowerCase();
            const grant = (modal.shares || []).find((row) =>
                (row.subject && String(row.subject).toLowerCase() === needle)
                || (row.email && String(row.email).toLowerCase() === needle)
                || (row.displayName && String(row.displayName).toLowerCase() === needle));
            if (!grant) {
                this.dispatch({ type: "ui/status", text: `No grant matching "${revokeWho}"` });
                return;
            }
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            try {
                await this.transport.revokeSessionShare(sessionId, { provider: grant.provider, subject: grant.subject });
                this.dispatch({ type: "ui/status", text: `Revoked ${revokeWho}` });
            } catch (error) {
                this.dispatch({ type: "ui/status", text: error?.message || String(error) });
            }
            return;
        }

        // Grant: an optional trailing access token picks read/write.
        const tokens = raw.split(/\s+/);
        const accessByToken = { r: "read", read: "read", w: "write", write: "write" };
        const lastToken = tokens.length > 1 ? tokens[tokens.length - 1].toLowerCase() : null;
        const access = lastToken && accessByToken[lastToken] ? accessByToken[lastToken] : "read";
        const who = lastToken && accessByToken[lastToken] ? tokens.slice(0, -1).join(" ") : raw;

        // Resolve the typed text against the member directory: an exact
        // displayName/email/subject match wins; otherwise a unique partial
        // match is accepted and multiple partial matches are ambiguous.
        const needle = who.toLowerCase();
        let grantee = null;
        if (typeof this.transport.listKnownUsers === "function") {
            let users = [];
            try {
                users = await this.transport.listKnownUsers({ limit: 500 });
            } catch {
                users = [];
            }
            const candidates = Array.isArray(users) ? users : [];
            grantee = candidates.find((user) =>
                (user.displayName && user.displayName.toLowerCase() === needle)
                || (user.email && user.email.toLowerCase() === needle)
                || (user.subject && user.subject.toLowerCase() === needle)) || null;
            if (!grantee) {
                const partial = candidates.filter((user) =>
                    (user.displayName && user.displayName.toLowerCase().includes(needle))
                    || (user.email && user.email.toLowerCase().includes(needle))
                    || (user.subject && user.subject.toLowerCase().includes(needle)));
                if (partial.length === 1) {
                    grantee = partial[0];
                } else if (partial.length > 1) {
                    this.dispatch({ type: "ui/status", text: `"${who}" is ambiguous (${partial.length} matches)` });
                    return;
                }
            }
        }
        if (!grantee) {
            // Not-yet-seen user: treat the text as a raw subject under the
            // caller's provider (mirrors the portal's resolveGrantee).
            const principal = this.getState().auth?.principal || null;
            grantee = { provider: principal?.provider || "dev", subject: who, email: null, displayName: null };
        }

        this.dispatch({ type: "ui/modal", modal: null });
        if (previousFocus) this.setFocus(previousFocus);
        try {
            await this.transport.grantSessionShare(
                sessionId,
                { provider: grantee.provider, subject: grantee.subject, email: grantee.email ?? null, displayName: grantee.displayName ?? null },
                access,
            );
            this.dispatch({ type: "ui/status", text: `Granted ${access} to ${who}` });
        } catch (error) {
            this.dispatch({ type: "ui/status", text: error?.message || String(error) });
        }
    }

    closeModal() {
        const modal = this.getState().ui.modal;
        if (!modal) return;
        this.dispatch({ type: "ui/modal", modal: null });
        if (modal.type === "themePicker" && modal.currentThemeId) {
            this.dispatch({ type: "ui/theme", themeId: modal.currentThemeId });
        }
        if (modal.previousFocus) {
            this.setFocus(modal.previousFocus);
        }
        this.dispatch({ type: "ui/status", text: "Connected" });
    }

    /**
     * Open or close one agent-picker section.
     *
     * The visible row list is rebuilt from the catalog, and selection is
     * carried by ITEM ID rather than index: collapsing a section above the
     * cursor shifts every index below it, and re-using the old number would
     * silently move the highlight onto a different agent.
     */
    toggleAgentPickerSection(sectionKey, force = null) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionAgentPicker" || !sectionKey) return;
        const collapsed = new Set(modal.collapsed || []);
        const shouldCollapse = force === null ? !collapsed.has(sectionKey) : force;
        if (shouldCollapse === collapsed.has(sectionKey)) return;
        if (shouldCollapse) collapsed.add(sectionKey);
        else collapsed.delete(sectionKey);

        const nextCollapsed = [...collapsed];
        const items = buildAgentPickerItems(modal.catalog || [], nextCollapsed, modal.genericItem || null);
        const selectedId = modal.items?.[modal.selectedIndex || 0]?.id;
        let nextIndex = items.findIndex((item) => item.id === selectedId);
        if (nextIndex < 0) {
            // The selected row was inside the section that just closed — land
            // on that section's own header, which is where it went.
            nextIndex = Math.max(0, items.findIndex((item) => item.sectionKey === sectionKey));
        }
        this.dispatch({
            type: "ui/modal",
            modal: { ...modal, collapsed: nextCollapsed, items, selectedIndex: nextIndex },
        });
    }

    /**
     * Left/right on the agent picker. Right opens a closed section (or steps
     * into it); left closes an open one, or jumps to the parent header when
     * the cursor is already on a leaf — the same shape as the session tree.
     */
    moveAgentPickerSection(delta) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "sessionAgentPicker") return false;
        const items = Array.isArray(modal.items) ? modal.items : [];
        const index = Math.max(0, Math.min(Number(modal.selectedIndex) || 0, items.length - 1));
        const item = items[index];
        if (!item) return false;

        if (delta > 0) {
            if (item.kind === "section" && item.collapsed) {
                this.toggleAgentPickerSection(item.sectionKey, false);
                return true;
            }
            return false;
        }

        if (item.kind === "section" && !item.collapsed) {
            this.toggleAgentPickerSection(item.sectionKey, true);
            return true;
        }
        for (let i = index - 1; i >= 0; i -= 1) {
            if (items[i].kind === "section" && items[i].depth < item.depth) {
                this.dispatch({ type: "ui/modalSelection", index: i });
                return true;
            }
        }
        return false;
    }

    moveModalSelection(delta) {
        const modal = this.getState().ui.modal;
        if (!modal) return;
        if (modal.type === "help") {
            const current = Math.max(0, Number(modal.selectedIndex) || 0);
            this.dispatch({ type: "ui/modalSelection", index: Math.max(0, current + delta) });
            return;
        }
        if (!Array.isArray(modal.items) || modal.items.length === 0) return;
        if (modal.type === "logFilter" || modal.type === "filesFilter" || modal.type === "historyFormat") {
            const currentPaneIndex = Math.max(0, Math.min(Number(modal.selectedIndex) || 0, modal.items.length - 1));
            const selected = modal.items[currentPaneIndex];
            if (!selected || !Array.isArray(selected.options) || selected.options.length === 0) return;
            const optionIds = selected.options.map((option) => option.id).filter(Boolean);
            if (optionIds.length === 0) return;
            const currentValue = modal.type === "filesFilter"
                ? this.getState().files.filter?.[selected.id] || optionIds[0]
                : modal.type === "historyFormat"
                    ? this.getState().executionHistory?.format || optionIds[0]
                    : this.getState().logs.filter?.[selected.id] || optionIds[0];
            const nextValue = cycleValue(optionIds, currentValue, delta);
            const nextOption = selected.options.find((option) => option.id === nextValue) || selected.options[0];
            this.dispatch({
                type: modal.type === "filesFilter" ? "files/filter" : modal.type === "historyFormat" ? "executionHistory/format" : "logs/filter",
                filter: modal.type === "historyFormat" ? undefined : { [selected.id]: nextValue },
                ...(modal.type === "historyFormat" ? { format: nextValue } : {}),
            });
            if (modal.type === "filesFilter") {
                this.ensureFilesForScope(nextValue).catch(() => {});
                this.ensureSelectedFilePreview().catch(() => {});
            }
            this.dispatch({
                type: "ui/status",
                text: `${modal.type === "filesFilter" ? "Files" : modal.type === "historyFormat" ? "History" : "Log"} filter updated: ${selected.label} = ${nextOption?.label || nextValue}`,
            });
            return;
        }
        const current = Math.max(0, Number(modal.selectedIndex) || 0);
        const next = Math.max(0, Math.min(current + delta, modal.items.length - 1));
        this.dispatch({ type: "ui/modalSelection", index: next });
    }

    moveModalPane(delta) {
        const modal = this.getState().ui.modal;
        if (modal?.type === "sessionAgentPicker") {
            this.moveAgentPickerSection(delta);
            return;
        }
        if (!modal || (modal.type !== "logFilter" && modal.type !== "filesFilter" && modal.type !== "historyFormat") || !Array.isArray(modal.items) || modal.items.length === 0) return;
        const current = Math.max(0, Number(modal.selectedIndex) || 0);
        const next = (current + delta + modal.items.length) % modal.items.length;
        const selected = modal.items[next];
        const currentValue = modal.type === "filesFilter"
            ? this.getState().files.filter?.[selected.id] || selected.options?.[0]?.id
            : modal.type === "historyFormat"
                ? this.getState().executionHistory?.format || selected.options?.[0]?.id
                : this.getState().logs.filter?.[selected.id] || selected.options?.[0]?.id;
        const currentOption = selected.options?.find((option) => option.id === currentValue) || selected.options?.[0];
        this.dispatch({ type: "ui/modalSelection", index: next });
        this.dispatch({
            type: "ui/status",
            text: `Editing ${selected.label}: ${currentOption?.label || currentValue || ""}`,
        });
    }

    async confirmModal() {
        const modal = this.getState().ui.modal;
        if (!modal) return;
        if (modal.type === "help") {
            this.closeModal();
            return;
        }
        if (modal.type === "confirm") {
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            if (modal.action === "cancelSession") {
                await this.cancelActiveSession({ confirmed: true });
            } else if (modal.action === "completeSession") {
                await this.completeActiveSession("Completed by user", { confirmed: true });
            } else if (modal.action === "deleteSession") {
                await this.deleteActiveSession({ confirmed: true });
            } else if (modal.action === "regenerateSession") {
                await this.regenerateActiveSession({ confirmed: true, ...(modal.extras || {}) });
            } else if (modal.action === "deleteArtifact") {
                await this.deleteSelectedArtifact({ confirmed: true });
            } else if (modal.action === "deleteMarkedArtifacts") {
                await this.deleteMarkedArtifacts({ confirmed: true });
            } else if (modal.action === "deleteAdminProvider") {
                await this.deleteSelectedAdminProvider();
            }
            return;
        }
        if (modal.type === "artifactUpload") {
            await this.confirmArtifactUploadModal();
            return;
        }
        if (modal.type === "renameSession") {
            await this.confirmRenameSessionModal();
            return;
        }
        if (modal.type === "shareSession") {
            await this.confirmShareSessionModal();
            return;
        }
        if (modal.type === "sessionGroupPicker") {
            await this.confirmSessionGroupPickerModal();
            return;
        }
        if (modal.type === "sessionGroupName") {
            await this.confirmSessionGroupNameModal();
            return;
        }
        if (modal.type === "sessionOwnerFilter") {
            this.toggleSessionOwnerFilter();
            return;
        }
        if (modal.type === "filesFilter") {
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) this.setFocus(previousFocus);
            return;
        }
        if (modal.type === "themePicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const nextTheme = getTheme(item?.id);
            if (!nextTheme) {
                this.dispatch({ type: "ui/status", text: "Unable to apply that theme" });
                return;
            }
            const previousFocus = modal.previousFocus;
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
            this.dispatch({ type: "ui/status", text: `Applied theme: ${nextTheme.label}` });
            return;
        }
        if (modal.type === "modelPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            if (item?.disabled) {
                // Keep the picker open — the selection is unusable, not wrong.
                this.dispatch({
                    type: "ui/status",
                    text: item.ghcpKeyMissing
                        ? "This model needs a GitHub Copilot provider — add your own in Admin Console first"
                        : "This model is not available",
                });
                return;
            }
            // Each successor opener replaces this modal itself, so the overlay
            // is NOT dismissed here: doing that before an awaited step blinked
            // the dialog off screen for the length of the step's fetch.
            const previousFocus = modal.previousFocus;
            if (!item) {
                if (modal.sessionOptions?.mode === "switchModel") {
                    this.dispatch({ type: "ui/modal", modal: null });
                    if (previousFocus) {
                        this.setFocus(previousFocus);
                    }
                    this.dispatch({ type: "ui/status", text: "No model selected" });
                    return;
                }
                await this.openSessionAgentPicker({}, previousFocus);
                return;
            }
            const defaultReasoning = resolveDefaultReasoningEffort(item);
            if (modal.sessionOptions?.mode === "switchModel") {
                await this.openReasoningEffortPicker(item, {
                    ...(modal.sessionOptions || {}),
                    model: item.id,
                    reasoningEffort: defaultReasoning ?? null,
                }, previousFocus);
                return;
            }
            await this.openReasoningEffortPicker(item, {
                ...(modal.sessionOptions || {}),
                model: item.id,
                ...(defaultReasoning ? { reasoningEffort: defaultReasoning } : {}),
            }, previousFocus);
            return;
        }
        if (modal.type === "reasoningEffortPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const previousFocus = modal.previousFocus;
            const sessionOptions = modal.sessionOptions || {};
            // Not dismissed here — the tier step (or the agent step it falls
            // through to) replaces this modal in one dispatch.
            await this.openContextTierPicker(modal.modelItem, {
                ...sessionOptions,
                ...(item?.id ? { reasoningEffort: item.id } : {}),
            }, previousFocus);
            return;
        }
        if (modal.type === "contextTierPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            const previousFocus = modal.previousFocus;
            const sessionOptions = modal.sessionOptions || {};
            const nextOptions = {
                ...sessionOptions,
                ...(item?.id ? { contextTier: item.id } : {}),
            };
            // Switch-model flow ends here — apply the model/effort/tier switch,
            // so this one DOES close the overlay. The new-session flow continues
            // to the agent picker, which replaces the modal itself once its
            // agent list has loaded.
            if (sessionOptions?.mode === "switchModel") {
                this.dispatch({ type: "ui/modal", modal: null });
                if (previousFocus) {
                    this.setFocus(previousFocus);
                }
                await this.switchSessionModel({ ...nextOptions, model: modal.modelItem?.id || sessionOptions.model });
                return;
            }
            await this.openSessionAgentPicker(nextOptions, previousFocus);
            return;
        }
        if (modal.type === "sessionAgentPicker") {
            const item = modal.items?.[modal.selectedIndex || 0];
            // Enter on a heading opens or closes it; the dialog stays up.
            if (item?.kind === "section") {
                this.toggleAgentPickerSection(item.sectionKey);
                return;
            }
            // A called-only agent is rendered so the package's composition is
            // visible, but starting one cold is not a thing you can do. Refuse
            // here rather than letting the create fail after the dialog closes.
            if (item && item.kind !== "generic" && item.supportsDirectStart === false) {
                this.dispatch({
                    type: "ui/status",
                    text: `${item.title || item.agentName} is created by another agent and cannot be started on its own`,
                });
                return;
            }
            const previousFocus = modal.previousFocus;
            const sessionOptions = modal.sessionOptions || {};
            this.dispatch({ type: "ui/modal", modal: null });
            if (previousFocus) {
                this.setFocus(previousFocus);
            }
            if (!item || item.kind === "generic") {
                await this.createSession(sessionOptions);
                return;
            }
            await this.createSessionForAgent(item.agentName, {
                ...sessionOptions,
                ...(item.title ? { title: item.title } : {}),
                ...(item.splash ? { splash: item.splash } : {}),
                ...(item.splashMobile ? { splashMobile: item.splashMobile } : {}),
                ...(item.initialPrompt ? { initialPrompt: item.initialPrompt } : {}),
            });
            return;
        }
        if (modal.type === "logFilter") {
            this.closeModal();
            return;
        }
        if (modal.type === "historyFormat") {
            this.closeModal();
            return;
        }
        if (modal.type === "artifactPicker") {
            await this.downloadArtifactModalSelection();
        }
    }

    openLogFilter() {
        const previousFocus = this.getState().ui.focusRegion;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "logFilter",
                title: "Log Filters",
                previousFocus,
                selectedIndex: 0,
                items: [
                    {
                        id: "source",
                        label: "Source nodes",
                        description: "Choose whether the log pane shows logs from all nodes or only the current orchestration.",
                        options: [
                            { id: "allNodes", label: "All nodes" },
                            { id: "currentOrchestration", label: "Current orchestration" },
                        ],
                    },
                    {
                        id: "level",
                        label: "Levels",
                        description: "Filter logs by severity/verbosity level.",
                        options: [
                            { id: "all", label: "All" },
                            { id: "info", label: "Info" },
                            { id: "warn", label: "Warn" },
                            { id: "error", label: "Error" },
                            { id: "debug", label: "Debug" },
                            { id: "trace", label: "Trace" },
                        ],
                    },
                    {
                        id: "format",
                        label: "Format",
                        description: "Raw shows the structured time/node/level summary. Pretty shows the cleaned message text, colored by orchestration vs activity.",
                        options: [
                            { id: "pretty", label: "Pretty text" },
                            { id: "raw", label: "Raw summary" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({ type: "ui/status", text: "Tab/Shift-Tab switch filters · Up/Down change values · Enter close · Esc cancel" });
    }

    openHistoryFormat() {
        const previousFocus = this.getState().ui.focusRegion;
        this.dispatch({
            type: "ui/modal",
            modal: {
                type: "historyFormat",
                title: "Execution History Format",
                previousFocus,
                selectedIndex: 0,
                items: [
                    {
                        id: "format",
                        label: "Format",
                        description: "Pretty prints a human-readable view with colored event kinds. Raw JSON shows the full event objects.",
                        options: [
                            { id: "pretty", label: "Pretty text" },
                            { id: "raw", label: "Raw JSON" },
                        ],
                    },
                ],
            },
        });
        this.dispatch({ type: "ui/status", text: "Up/Down change format · Enter close · Esc cancel" });
    }

    toggleLogTail() {
        const logs = this.getState().logs;
        if (!logs.available) {
            this.dispatch({
                type: "ui/status",
                text: logs.availabilityReason || "Log tailing is not available in this environment",
            });
            return;
        }

        if (logs.tailing) {
            this.detachLogStream();
            if (typeof this.transport.stopLogTail === "function") {
                this.transport.stopLogTail().catch(() => {});
            }
            this.dispatch({ type: "logs/tailing", tailing: false });
            this.dispatch({ type: "ui/status", text: "Log tailing stopped" });
            return;
        }

        if (typeof this.transport.startLogTail !== "function") {
            this.dispatch({ type: "ui/status", text: "Log tailing is not supported by this transport" });
            return;
        }

        this.logUnsubscribe = this.transport.startLogTail((entryOrBatch) => {
            const entries = Array.isArray(entryOrBatch) ? entryOrBatch : [entryOrBatch];
            if (entries.length > 0) {
                this.dispatch({ type: "logs/append", entries });
            }
        });
        this.dispatch({ type: "logs/tailing", tailing: true });
        this.dispatch({ type: "ui/status", text: "Log tailing started" });
    }

    async sendPrompt() {
        const state = this.getState();
        const rawPrompt = state.ui.prompt;
        const promptAttachments = this.getPromptAttachments();
        const attachmentSessionId = promptAttachments[0]?.sessionId || null;
        const prompt = expandPromptAttachments(rawPrompt, promptAttachments);

        let sessionId = state.sessions.activeSessionId;
        if (attachmentSessionId) {
            sessionId = attachmentSessionId;
            if (state.sessions.activeSessionId !== attachmentSessionId) {
                await this.loadSession(attachmentSessionId);
            }
        }
        let activeSession = sessionId ? state.sessions.byId[sessionId] || null : null;
        if (sessionId && !activeSession) {
            activeSession = this.getState().sessions.byId[sessionId] || null;
        }
        if (!sessionId) {
            const created = await this.createSession({});
            if (!created?.sessionId) return;
            sessionId = created.sessionId;
            activeSession = this.getState().sessions.byId[sessionId] || null;
        }

        // Empty Enter on a session with pending outbox items forces an immediate
        // dispatch of any pending merge group; this is the "send batch" affordance.
        // Staged image attachments make an empty prompt sendable (a default
        // caption is filled in below), so they bypass this early return.
        const hasStagedImages = promptAttachments.some((a) => a?.kind === "image");
        if (!prompt.trim() && !hasStagedImages) {
            if (sessionId && this.getPendingOutboxItems(sessionId).length > 0) {
                await this.dispatchPendingOutbox(sessionId).catch(() => {});
            }
            return;
        }

        const activePendingQuestion = activeSession?.pendingQuestion || null;
        const answeringPendingQuestion = Boolean(activePendingQuestion?.question);
        const promptEdit = this.getPromptEditSessionMatch(sessionId);

        // If we're editing a pending item, the editor text already mutates that
        // item in place via setPrompt. Just clear the editor and dispatch.
        if (promptEdit) {
            const selectedOutboxItem = this.getSessionOutbox(sessionId)
                .find((item) => item.id === promptEdit.itemId);
            if (selectedOutboxItem?.phase === "queued" || selectedOutboxItem?.phase === "cancelling") {
                this.exitPendingPromptEdit({ restoreDraft: true });
                return;
            }
            this.setPrompt("", 0);
            this.setPromptAttachments([]);
            await this.dispatchPendingOutbox(sessionId).catch(() => {});
            return;
        }

        // Pending questions still take the direct sendAnswer path — answers are
        // an orchestration-level reply, not a user message, and don't merge.
        if (answeringPendingQuestion && typeof this.transport.sendAnswer === "function") {
            const answeredAt = Date.now();
            const answeredPendingQuestion = {
                ...activePendingQuestion,
                answer: prompt,
                answeredAt,
                pendingPhase: "pending",
            };
            this.setPrompt("", 0);
            this.setPromptAttachments([]);
            this.dispatch({
                type: "sessions/merged",
                session: {
                    sessionId,
                    pendingQuestion: null,
                    answeredPendingQuestion,
                },
            });
            this.dispatch({ type: "ui/status", text: "Sending answer..." });
            try {
                await this.transport.sendAnswer(sessionId, prompt);
                this.dispatch({
                    type: "sessions/merged",
                    session: {
                        sessionId,
                        answeredPendingQuestion: {
                            ...answeredPendingQuestion,
                            pendingPhase: "queued",
                        },
                    },
                });
                this.scheduleSessionDetailSync(sessionId, 100);
                this.syncSessionEvents(sessionId).catch(() => {});
                this.scheduleSessionsRefresh(1000);
                this.dispatch({ type: "ui/status", text: "Answer sent" });
            } catch (error) {
                this.dispatch({
                    type: "sessions/merged",
                    session: { sessionId, answeredPendingQuestion: null },
                });
                this.dispatch({
                    type: "sessions/merged",
                    session: { sessionId, pendingQuestion: activePendingQuestion },
                });
                if (!String(this.getState().ui.prompt || "").trim()) {
                    this.setPrompt(prompt, String(prompt || "").length);
                }
                this.dispatch({ type: "ui/status", text: error?.message || String(error) });
            }
            return;
        }

        // Universal path: every user message goes through the local outbox first.
        // The dispatcher coalesces synchronous sends into one durable enqueue.
        // We still `await` the dispatcher so callers (and tests) that `await
        // sendPrompt()` see the durable enqueue completed before they observe
        // outbox state. Sends that fire in the same tick (e.g. multiple
        // `controller.sendPrompt()` calls without intervening `await`s) still
        // merge because the second call enters before the first dispatcher
        // microtask runs.
        //
        // Image attachments upload FIRST (artifact = source of truth), then the
        // message references them by filename. A failed upload keeps the prompt
        // and the staged images — a message never goes out half-attached.
        const pendingImages = promptAttachments.filter((a) => a?.kind === "image");
        let attachmentRefs = null;
        if (pendingImages.length > 0) {
            const needsUpload = pendingImages.some((a) => a.file);
            if (needsUpload && typeof this.transport.uploadArtifactFromFile !== "function") {
                this.dispatch({ type: "ui/status", text: "This transport does not support image attachments." });
                return;
            }
            const uploadItem = this.buildOutboxItem("", "pending");
            this.dispatch({ type: "ui/status", text: `Uploading ${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""}...` });
            try {
                attachmentRefs = await this.uploadPendingImageAttachments(sessionId, pendingImages, uploadItem.id);
                this.dispatch({ type: "ui/status", text: "" });
            } catch (error) {
                this.dispatch({ type: "ui/status", text: `Image upload failed: ${error?.message || error}` });
                return;
            }
        }
        const outboundPrompt = prompt.trim()
            ? prompt
            : (attachmentRefs && attachmentRefs.length > 0 ? "See the attached image(s)." : prompt);
        this.queuePromptInOutbox(sessionId, outboundPrompt, attachmentRefs ? { attachments: attachmentRefs } : null);
        this.setPrompt("", 0);
        this.setPromptAttachments([]);
        await this.dispatchPendingOutbox(sessionId).catch(() => {});
    }

    setPrompt(prompt, promptCursor = String(prompt || "").length) {
        const nextPrompt = String(prompt || "");
        const nextCursor = Math.max(0, Math.min(
            Number.isFinite(promptCursor) ? promptCursor : nextPrompt.length,
            nextPrompt.length,
        ));
        const currentUi = this.getState().ui;
        if (currentUi.prompt === nextPrompt && currentUi.promptCursor === nextCursor) {
            return;
        }
        if (currentUi.promptEdit?.sessionId && currentUi.promptEdit?.itemId) {
            const items = this.getSessionOutbox(currentUi.promptEdit.sessionId);
            const nextItems = items.map((item) => (
                item.id === currentUi.promptEdit.itemId && item.phase === "pending"
                    && item.attempted !== true
                    ? { ...item, text: nextPrompt }
                    : item
            ));
            this.setSessionOutboxItems(currentUi.promptEdit.sessionId, nextItems);
        }
        this.dispatch({ type: "ui/prompt", prompt: nextPrompt, promptCursor: nextCursor });
        this.syncPromptReferenceBrowser();
    }

    setPromptCursor(promptCursor) {
        const prompt = this.getState().ui.prompt || "";
        this.setPrompt(prompt, promptCursor);
    }

    insertPromptText(text) {
        const state = this.getState().ui;
        const next = insertPromptTextAtCursor(state.prompt, state.promptCursor, text);
        this.setPrompt(next.prompt, next.cursor);
    }

    appendPromptChar(ch) {
        this.insertPromptText(ch);
    }

    deletePromptChar() {
        const state = this.getState().ui;
        const next = deletePromptCharBackward(state.prompt, state.promptCursor);
        this.setPrompt(next.prompt, next.cursor);
    }

    deletePromptWordBackward() {
        const state = this.getState().ui;
        const next = deletePromptWordBackward(state.prompt, state.promptCursor);
        this.setPrompt(next.prompt, next.cursor);
    }

    movePromptCursor(delta) {
        const state = this.getState().ui;
        this.setPrompt(state.prompt, clampPromptCursor(state.prompt, state.promptCursor + delta));
    }

    movePromptCursorWord(direction) {
        const state = this.getState().ui;
        this.setPrompt(state.prompt, movePromptCursorByWord(state.prompt, state.promptCursor, direction));
    }

    movePromptCursorVertical(direction) {
        const state = this.getState().ui;
        const nextCursor = movePromptCursorVertically(state.prompt, state.promptCursor, direction);
        if (nextCursor !== state.promptCursor) {
            this.setPrompt(state.prompt, nextCursor);
            return;
        }
        if (direction < 0 && this.selectPreviousPendingPrompt()) return;
        if (direction > 0 && this.selectNextPendingPrompt()) return;
        this.setPrompt(state.prompt, nextCursor);
    }

    getCurrentLayout(overrides = {}) {
        const layoutState = this.getState().ui.layout || {};
        const uiState = this.getState().ui;
        const prompt = overrides.prompt ?? uiState.prompt;
        return computeLegacyLayout({
            width: overrides.width ?? layoutState.viewportWidth ?? 120,
            height: overrides.height ?? layoutState.viewportHeight ?? 40,
        },
        overrides.paneAdjust ?? layoutState.paneAdjust ?? 0,
        overrides.promptRows ?? uiState.promptRows ?? getPromptInputRows(prompt),
        overrides.sessionPaneAdjust ?? layoutState.sessionPaneAdjust ?? 0,
        overrides.activityPaneAdjust ?? layoutState.activityPaneAdjust ?? 0,
        overrides.fullscreenPane ?? uiState.fullscreenPane ?? null);
    }

    getSessionListMaxRows(layout = this.getCurrentLayout()) {
        const paneHeight = layout.fullscreenPane === FOCUS_REGIONS.SESSIONS
            ? layout.bodyHeight
            : layout.sessionPaneHeight;
        return Math.max(3, paneHeight - 2);
    }

    setViewport(viewport = {}) {
        const nextWidth = Math.max(40, Number(viewport.width) || 120);
        const nextHeight = Math.max(18, Number(viewport.height) || 40);
        const currentLayout = this.getState().ui.layout || {};
        if (currentLayout.viewportWidth !== nextWidth || currentLayout.viewportHeight !== nextHeight) {
            this.dispatch({
                type: "ui/viewport",
                width: nextWidth,
                height: nextHeight,
            });
        }
        const nextLayout = this.getCurrentLayout({ width: nextWidth, height: nextHeight });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    setFocus(focusRegion) {
        // Carry the raw request alongside the normalized region: on a phone a
        // workspace region (sessions/chat) normalizes to inspector, and the
        // mobile follow-focus effect must not read that as "open diagnostics".
        this.dispatch({
            type: "ui/focus",
            focusRegion: normalizeFocusRegion(focusRegion, this.getCurrentLayout()),
            requestedFocusRegion: focusRegion,
        });
    }

    focusNext() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        const order = getFocusOrderForLayout(layout);
        this.setFocus(cycleValue(order, current, 1));
    }

    focusPrev() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        const order = getFocusOrderForLayout(layout);
        this.setFocus(cycleValue(order, current, -1));
    }

    focusLeft() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        this.setFocus(getFocusLeftTarget(current, layout));
    }

    focusRight() {
        const layout = this.getCurrentLayout();
        const current = normalizeFocusRegion(this.getState().ui.focusRegion, layout);
        this.setFocus(getFocusRightTarget(current, layout));
    }

    adjustPaneSplit(delta) {
        const layoutState = this.getState().ui.layout || {};
        const viewportWidth = layoutState.viewportWidth ?? 120;
        const nextAdjust = Math.max(-viewportWidth, Math.min(viewportWidth, (layoutState.paneAdjust || 0) + delta));
        this.dispatch({
            type: "ui/paneAdjust",
            paneAdjust: nextAdjust,
        });
        const nextLayout = this.getCurrentLayout({ paneAdjust: nextAdjust });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    adjustSessionPaneSplit(delta) {
        const layoutState = this.getState().ui.layout || {};
        const currentLayout = this.getCurrentLayout();
        const bodyHeight = currentLayout.bodyHeight ?? (layoutState.viewportHeight ?? 40);
        // Allow the adjust to push past the per-pane minimums so the
        // collapse logic in computeLegacyLayout can fully hide one of the
        // two panes (mirrors adjustActivityPaneSplit).
        const nextAdjust = Math.max(-bodyHeight, Math.min(bodyHeight, (layoutState.sessionPaneAdjust || 0) + delta));
        this.dispatch({
            type: "ui/sessionPaneAdjust",
            sessionPaneAdjust: nextAdjust,
        });
        const nextLayout = this.getCurrentLayout({ sessionPaneAdjust: nextAdjust });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    adjustActivityPaneSplit(delta) {
        const layoutState = this.getState().ui.layout || {};
        const currentLayout = this.getCurrentLayout();
        const bodyHeight = currentLayout.bodyHeight ?? (layoutState.viewportHeight ?? 40);
        const nextAdjust = Math.max(-bodyHeight, Math.min(bodyHeight, (layoutState.activityPaneAdjust || 0) + delta));
        this.dispatch({
            type: "ui/activityPaneAdjust",
            activityPaneAdjust: nextAdjust,
        });
        const nextLayout = this.getCurrentLayout({ activityPaneAdjust: nextAdjust });
        const currentFocus = this.getState().ui.focusRegion;
        const safeFocus = normalizeFocusRegion(currentFocus, nextLayout);
        if (safeFocus !== currentFocus) {
            this.setFocus(safeFocus);
        }
    }

    // Focus-aware vertical resize: [ / ] grow or shrink whichever pane is
    // focused. Sessions and chat share the left-column vertical split;
    // inspector and activity share the right-column vertical split. A positive
    // delta always grows the focused pane at the expense of its sibling.
    resizeFocusedPane(delta) {
        const focus = this.getState().ui.focusRegion;
        const layoutState = this.getState().ui.layout || {};
        const bodyHeight = this.getCurrentLayout().bodyHeight ?? (layoutState.viewportHeight ?? 40);
        const totalHeight = layoutState.viewportHeight ?? 40;
        // Bound the adjust so BOTH panes stay strictly ABOVE their collapse
        // thresholds (the collapse check is `<=`, hence the +1). A keyboard
        // resize then never hides a pane — which would drop it from the Tab
        // cycle — and never lands on a dead plateau. A positive delta grows the
        // focused pane.
        const clamp = (current, signed, min, max) => {
            const hi = Math.max(min, max);
            return Math.max(min, Math.min(hi, (current || 0) + signed));
        };
        if (focus === FOCUS_REGIONS.SESSIONS || focus === FOCUS_REGIONS.CHAT) {
            const base = getBaseSessionPaneHeight(bodyHeight);
            const minH = MIN_SESSION_PANE_HEIGHT + 1;
            const maxH = Math.min(getMaxSessionPaneHeight(totalHeight, bodyHeight), bodyHeight - MIN_CHAT_PANE_HEIGHT - 1);
            const signed = focus === FOCUS_REGIONS.CHAT ? -delta : delta;
            const next = clamp(layoutState.sessionPaneAdjust, signed, minH - base, maxH - base);
            this.dispatch({ type: "ui/sessionPaneAdjust", sessionPaneAdjust: next });
        } else if (focus === FOCUS_REGIONS.INSPECTOR || focus === FOCUS_REGIONS.ACTIVITY) {
            const base = Math.max(MIN_ACTIVITY_PANE_HEIGHT, Math.floor(bodyHeight * DEFAULT_ACTIVITY_PANE_RATIO));
            const minH = MIN_ACTIVITY_PANE_HEIGHT + 1;
            const maxH = bodyHeight - MIN_INSPECTOR_PANE_HEIGHT - 1;
            const signed = focus === FOCUS_REGIONS.INSPECTOR ? -delta : delta;
            const next = clamp(layoutState.activityPaneAdjust, signed, minH - base, maxH - base);
            this.dispatch({ type: "ui/activityPaneAdjust", activityPaneAdjust: next });
        }
    }

    getActiveSequenceCompletedTurns() {
        const state = this.getState();
        const sid = state.sessions.activeSessionId;
        if (!sid) return [];
        const history = state.history.bySessionId?.get?.(sid);
        const turns = [];
        const seen = new Set();
        for (const event of history?.events || []) {
            if (event?.eventType !== "session.turn_completed") continue;
            const turn = Number(event?.data?.turnIndex ?? event?.data?.iteration);
            if (!Number.isFinite(turn) || seen.has(turn)) continue;
            seen.add(turn);
            turns.push(turn);
        }
        turns.sort((a, b) => a - b);
        return turns;
    }

    // Move the sequence-tab turn cursor among completed turns. First press with
    // no selection lands on the latest turn; subsequent presses step.
    moveSequenceSelection(delta) {
        const turns = this.getActiveSequenceCompletedTurns();
        if (turns.length === 0) return;
        const at = turns.indexOf(Number(this.getState().ui.sequenceSelectedTurn));
        const index = at === -1
            ? turns.length - 1
            : Math.max(0, Math.min(turns.length - 1, at + delta));
        this.dispatch({ type: "ui/sequenceSelectedTurn", turn: turns[index] });
    }

    toggleSequenceTurnExpanded() {
        const turns = this.getActiveSequenceCompletedTurns();
        if (turns.length === 0) return;
        let selected = Number(this.getState().ui.sequenceSelectedTurn);
        if (!turns.includes(selected)) {
            selected = turns[turns.length - 1];
            this.dispatch({ type: "ui/sequenceSelectedTurn", turn: selected });
        }
        const expanded = Array.isArray(this.getState().ui.sequenceExpandedTurns)
            ? this.getState().ui.sequenceExpandedTurns.map(Number)
            : [];
        const next = expanded.includes(selected)
            ? expanded.filter((turn) => turn !== selected)
            : [...expanded, selected];
        this.dispatch({ type: "ui/sequenceExpandedTurns", turns: next });
    }

    nextInspectorTab() {
        const current = this.getState().ui.inspectorTab;
        const inspectorTab = cycleValue(INSPECTOR_TABS, current, 1);
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    prevInspectorTab() {
        const inspectorTab = cycleValue(INSPECTOR_TABS, this.getState().ui.inspectorTab, -1);
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    cycleInspectorTab() {
        this.nextInspectorTab();
    }

    toggleStatsView() {
        const modes = ["session", "fleet", "users"];
        const current = this.getState().ui.statsViewMode;
        const currentIndex = modes.includes(current) ? modes.indexOf(current) : 0;
        const statsViewMode = modes[(currentIndex + 1) % modes.length];
        this.setStatsViewMode(statsViewMode);
    }

    setStatsViewMode(statsViewMode) {
        this.dispatch({
            type: "ui/statsViewMode",
            statsViewMode,
        });
        if (this.getState().ui.inspectorTab === "stats") {
            this.ensureInspectorData("stats").catch(() => {});
        }
    }

    async selectInspectorTab(inspectorTab) {
        if (!INSPECTOR_TABS.includes(inspectorTab)) return;
        this.dispatch({
            type: "ui/inspectorTab",
            inspectorTab,
        });
        await this.ensureInspectorData(inspectorTab).catch(() => {});
    }

    async moveSession(delta) {
        const state = this.getState();
        const rows = selectSessionRows(state);
        if (rows.length === 0) return;
        const currentId = state.sessions.activeSessionId || rows[0].sessionId;
        const currentIndex = Math.max(0, rows.findIndex((row) => row.sessionId === currentId));
        const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + delta));
        const nextId = rows[nextIndex].sessionId;
        this.navigateToSession(nextId);
    }

    /**
     * Move the selection now; fetch the session once the movement settles.
     *
     * `loadSession` force-refetches history, syncs detail, re-attaches the live
     * event stream and refreshes the inspector — four round trips. Driving that
     * from every keypress meant scrolling a list of sessions fired a request
     * pair per row, and against a remote deployment the UI ran behind the
     * cursor by however long the network took. The highlight is local state and
     * moves immediately; only the fetching waits for the user to stop.
     *
     * A CLICK still loads immediately — that is a deliberate choice of one
     * session, not a scroll through many.
     */
    navigateToSession(sessionId) {
        if (!sessionId) return;
        if (this.getState().sessions.activeSessionId !== sessionId) {
            this.dispatch({ type: "sessions/selected", sessionId });
            // Same per-session reset loadSession does, so the sequence tab does
            // not show another session's turn while the fetch is pending.
            this.dispatch({ type: "ui/sequenceExpandedTurns", turns: [] });
            this.dispatch({ type: "ui/sequenceSelectedTurn", turn: null });
        }
        if (this.sessionNavSettleTimer) clearTimeout(this.sessionNavSettleTimer);
        this.sessionNavSettleTimer = setTimeout(() => {
            this.sessionNavSettleTimer = null;
            this.loadSession(sessionId).catch(() => {});
        }, SESSION_NAV_SETTLE_MS);
    }

    getSessionPageSize() {
        const layout = this.getCurrentLayout();
        const paneHeight = layout.fullscreenPane === FOCUS_REGIONS.SESSIONS
            ? layout.bodyHeight
            : layout.sessionPaneHeight;
        return Math.max(1, paneHeight - 3);
    }

    async moveSessionPage(deltaPages) {
        const pageSize = this.getSessionPageSize();
        await this.moveSession(pageSize * deltaPages);
    }

    inspectorUsesBottomScroll() {
        return INSPECTOR_BOTTOM_ANCHORED_TABS.has(this.getState().ui.inspectorTab);
    }

    paneUsesStickyBottomFollow(pane, state = this.getState()) {
        if (pane === "activity") return true;
        if (pane === "inspector") return state.ui.inspectorTab === "logs";
        return false;
    }

    isPaneFollowingBottom(pane, state = this.getState()) {
        if (!this.paneUsesStickyBottomFollow(pane, state)) return false;
        return state.ui.followBottom?.[pane] !== false;
    }

    getPaneVisualScrollOffset(pane, state = this.getState()) {
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        const storedOffset = Math.max(0, Math.min(Number(state.ui.scroll?.[pane]) || 0, maxOffset));
        if (this.isPaneFollowingBottom(pane, state)) {
            return Math.max(0, maxOffset - storedOffset);
        }
        return storedOffset;
    }

    applyPaneVisualScrollOffset(pane, offset, options = {}, state = this.getState()) {
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        // fromViewport: the offset was measured off the real DOM (scrollTop /
        // row height), which the browser has already bounded. Clamping it
        // against the CONTROLLER's max — counted in TUI render-metric rows, a
        // different unit — teleported the pane on the first wheel tick: one
        // 100px notch re-applied as metric-max × 16px, thousands of pixels
        // away. The two row spaces must never clamp each other.
        const nextOffset = options.fromViewport
            ? Math.max(0, Number(offset) || 0)
            : Math.max(0, Math.min(Number(offset) || 0, maxOffset));
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            const followBottom = options.followBottom !== undefined
                ? Boolean(options.followBottom)
                : options.atBottom !== undefined
                    ? Boolean(options.atBottom)
                    : nextOffset >= maxOffset;
            this.dispatch({ type: "ui/followBottom", pane, followBottom });
            this.dispatch({ type: "ui/scroll", pane, offset: followBottom ? 0 : nextOffset });
            return nextOffset;
        }

        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        return nextOffset;
    }

    updatePaneScrollFromViewport(pane, offset, options = {}) {
        const state = this.getState();
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            this.applyPaneVisualScrollOffset(pane, offset, { ...options, fromViewport: true }, state);
            return;
        }
        this.scrollPaneTo(pane, offset);
    }

    expandActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        this.dispatch({ type: "sessions/expand", sessionId });
    }

    collapseActiveSession() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        this.dispatch({ type: "sessions/collapse", sessionId });
    }

    scrollPane(pane, delta) {
        const state = this.getState();
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            const current = this.getPaneVisualScrollOffset(pane, state);
            const nextOffset = Math.max(0, Math.min(current - delta, maxOffset));
            this.applyPaneVisualScrollOffset(pane, nextOffset, { followBottom: nextOffset >= maxOffset }, state);
            return;
        }
        const current = Math.max(0, Math.min(Number(state.ui.scroll?.[pane]) || 0, maxOffset));
        const nextOffset = Math.max(0, Math.min(current + delta, maxOffset));
        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        if (pane === "chat" && delta > 0) {
            if (current >= maxOffset) {
                this.handleChatTopHistoryScrollIntent(nextOffset).catch(() => {});
            } else if (nextOffset >= maxOffset) {
                this.armChatTopHistoryLoad();
            }
        } else if (pane === "chat" && delta < 0) {
            this.disarmChatTopHistoryLoad();
        }
    }

    scrollPaneTo(pane, offset) {
        const state = this.getState();
        const maxOffset = this.getPaneMaxScrollOffset(pane, state);
        const nextOffset = Math.max(0, Math.min(Number(offset) || 0, maxOffset));
        if (this.paneUsesStickyBottomFollow(pane, state)) {
            this.applyPaneVisualScrollOffset(pane, nextOffset, { followBottom: nextOffset >= maxOffset }, state);
            return;
        }
        this.dispatch({ type: "ui/scroll", pane, offset: nextOffset });
        if (pane === "chat") {
            if (maxOffset > 0 && nextOffset >= maxOffset) {
                this.armChatTopHistoryLoad();
            } else {
                this.disarmChatTopHistoryLoad();
            }
        }
    }

    armChatTopHistoryLoad() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        this.chatTopHistoryLoadArmed = true;
        this.chatTopHistoryLoadSessionId = sessionId;
    }

    disarmChatTopHistoryLoad() {
        this.chatTopHistoryLoadArmed = false;
        this.chatTopHistoryLoadSessionId = null;
    }

    async handleChatTopHistoryScrollIntent(requestedScrollOffset, options = {}) {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        if (!options.force && (!this.chatTopHistoryLoadArmed || this.chatTopHistoryLoadSessionId !== sessionId)) {
            this.armChatTopHistoryLoad();
            return;
        }

        await this.maybeAutoExpandActiveHistory(requestedScrollOffset, {
            pages: AUTO_HISTORY_SCROLL_PAGE_COUNT,
            // Always bypass the offset gate. Every caller of this method fires
            // only when the DOM scroller is already AT the top — a direct
            // measurement. The gate is a second, weaker guess that compares a
            // DOM-derived offset against `selectChatLines` metrics, i.e. the
            // TERMINAL wrapped-line count, which the rich renderer does not
            // use. On a session whose messages are long (tables, code blocks)
            // the terminal line count balloons far past the rich DOM's scroll
            // extent, so the gate could never open and older history was
            // unreachable — while a session of short messages worked fine.
            // The arm/fire handshake above still debounces the wheel path.
            force: true,
        });
    }

    /** True when the artifact preview has taken over the activity slot. */
    artifactPreviewOwnsActivitySlot(state = this.getState()) {
        return state.ui.inspectorTab === "files" && Boolean(state.files?.selectedArtifactId);
    }

    /** Inspector focus with the Files tab open = the artifact list is driving. */
    focusIsArtifactList(state = this.getState()) {
        return state.ui.focusRegion === FOCUS_REGIONS.INSPECTOR && state.ui.inspectorTab === "files";
    }

    getScrollablePaneForFocus() {
        const state = this.getState();
        const focus = state.ui.focusRegion;
        if (focus === FOCUS_REGIONS.CHAT) return "chat";
        if (focus === FOCUS_REGIONS.ACTIVITY) {
            // The preview occupies the activity slot while an artifact is
            // selected, so activity focus must scroll the PREVIEW. This is what
            // lets clicking the list and clicking the preview mean different
            // things: the list keeps inspector focus (arrows move the
            // selection) while the preview claims activity focus (arrows
            // scroll it).
            if (this.artifactPreviewOwnsActivitySlot(state)) return "filePreview";
            return "activity";
        }
        if (focus === FOCUS_REGIONS.INSPECTOR) {
            if (this.getState().ui.inspectorTab === "files") return "filePreview";
            return "inspector";
        }
        return null;
    }

    scrollCurrentPane(delta) {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.scrollPane(pane, delta);
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        const usesTopScroll = pane === "inspector" || pane === "filePreview";
        this.scrollPane(pane, usesTopScroll && !inspectorUsesBottomScroll ? -delta : delta);
    }

    scrollCurrentPaneToTop() {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.applyPaneVisualScrollOffset(pane, 0, { followBottom: false });
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        if (pane === "chat" || pane === "activity" || inspectorUsesBottomScroll) {
            this.scrollPaneTo(pane, Number.MAX_SAFE_INTEGER);
            return;
        }
        this.scrollPaneTo(pane, 0);
    }

    scrollCurrentPaneToBottom() {
        const pane = this.getScrollablePaneForFocus();
        if (!pane) return;
        if (this.paneUsesStickyBottomFollow(pane)) {
            this.applyPaneVisualScrollOffset(pane, Number.MAX_SAFE_INTEGER, { followBottom: true });
            return;
        }
        const inspectorUsesBottomScroll = pane === "inspector" && this.inspectorUsesBottomScroll();
        if (pane === "chat" || pane === "activity" || inspectorUsesBottomScroll) {
            this.scrollPaneTo(pane, 0);
            return;
        }
        this.scrollPaneTo(pane, Number.MAX_SAFE_INTEGER);
    }

    async expandActiveHistory() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        await this.expandSessionHistory(sessionId);
    }

    getActiveChatRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.leftHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.leftWidth - 4);
        const contentHeight = Math.max(1, layout.chatPaneHeight - 2);
        const lines = selectChatLines(state, contentWidth);
        // The live "Working" strip and the queued-prompt overlay are both
        // pinned in the bottom-sticky region (matching the ChatPane render),
        // so the transcript scroll math must reserve them here — not inline.
        const bottomStickyLines = [
            ...selectOutboxOverlayLines(state, contentWidth),
            ...selectLiveActivityLines(state),
        ];
        const bottomStickyHeight = Math.min(
            Math.max(0, Math.floor(contentHeight * 0.34)),
            countWrappedRenderableLines(bottomStickyLines, contentWidth),
        );
        const totalLines = countWrappedRenderableLines(lines, contentWidth);
        return {
            contentWidth,
            contentHeight: Math.max(1, contentHeight - bottomStickyHeight),
            totalLines,
        };
    }

    getActivityRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.rightHidden || layout.activityHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.rightWidth - 4);
        const contentHeight = Math.max(1, layout.activityPaneHeight - 2);
        const activeSessionId = state.sessions.activeSessionId;
        const selectorState = {
            sessions: {
                activeSessionId,
                byId: activeSessionId
                    ? { [activeSessionId]: state.sessions.byId[activeSessionId] || null }
                    : {},
            },
            history: {
                bySessionId: activeSessionId
                    ? new Map([[activeSessionId, state.history.bySessionId.get(activeSessionId) || null]])
                    : new Map(),
            },
        };
        const activity = selectActivityPane(selectorState);
        return {
            contentWidth,
            contentHeight,
            totalLines: countWrappedRenderableLines(activity.lines, contentWidth),
        };
    }

    getInspectorRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if (layout.rightHidden || layout.inspectorHidden) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                stickyLineCount: 0,
                totalLines: 0,
            };
        }

        const contentWidth = Math.max(20, layout.rightWidth - 4);
        const activeSessionId = state.sessions.activeSessionId;
        const activeOrchestration = activeSessionId
            ? state.orchestration.bySessionId?.[activeSessionId] || null
            : null;
        const selectorState = {
            branding: state.branding,
            sessions: {
                activeSessionId,
                byId: state.sessions.byId,
                flat: state.sessions.flat,
            },
            history: {
                bySessionId: state.history.bySessionId,
            },
            orchestration: {
                bySessionId: activeSessionId && activeOrchestration
                    ? { [activeSessionId]: activeOrchestration }
                    : {},
            },
            logs: state.logs,
            sessionStats: state.sessionStats,
            fleetStats: state.fleetStats,
            ui: {
                inspectorTab: state.ui.inspectorTab,
                statsViewMode: state.ui.statsViewMode,
            },
            executionHistory: state.executionHistory,
        };
        const inspector = selectInspector(selectorState, { width: contentWidth });
        const tabLine = inspector.tabs.map((tab) => ({
            text: tab === inspector.activeTab ? `[${tab}] ` : `${tab} `,
            color: tab === inspector.activeTab ? "magenta" : "gray",
            bold: tab === inspector.activeTab,
        }));
        const normalizedLines = (inspector.lines || []).map((line) => (typeof line === "string"
            ? { text: line, color: "white" }
            : line));
        const stickyLines = inspector.activeTab === "sequence"
            ? [
                tabLine,
                ...((inspector.stickyLines || []).map((line) => (typeof line === "string"
                    ? { text: line, color: "white" }
                    : line))),
            ]
            : [];
        const bodyLines = inspector.activeTab === "sequence"
            ? normalizedLines
            : [tabLine, ...normalizedLines];
        return {
            contentWidth,
            contentHeight: Math.max(1, layout.inspectorPaneHeight - 2),
            stickyLineCount: countWrappedRenderableLines(stickyLines, contentWidth),
            totalLines: countWrappedRenderableLines(bodyLines, contentWidth),
        };
    }

    getFilePreviewRenderMetrics(state = this.getState()) {
        const layout = this.getCurrentLayout();
        if ((layout.rightHidden || layout.inspectorHidden) && !state.files?.fullscreen) {
            return {
                contentWidth: 20,
                contentHeight: 1,
                totalLines: 0,
            };
        }

        const fullscreen = state.ui.inspectorTab === "files" && Boolean(state.files?.fullscreen);
        const width = fullscreen ? layout.totalWidth : layout.rightWidth;
        const height = fullscreen ? Math.max(10, layout.bodyHeight) : layout.inspectorPaneHeight;
        const outerContentWidth = Math.max(20, width - 4);
        const previewWidth = Math.max(8, outerContentWidth - 4);

        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        const selectorState = {
            sessions: {
                activeSessionId,
                byId: activeSessionId && activeSession
                    ? { [activeSessionId]: activeSession }
                    : {},
                flat: state.sessions.flat,
            },
            files: {
                bySessionId: state.files.bySessionId,
                fullscreen: Boolean(state.files.fullscreen),
                selectedArtifactId: state.files.selectedArtifactId,
                filter: state.files.filter,
            },
            ui: {
                scroll: {
                    filePreview: state.ui.scroll.filePreview,
                },
            },
        };
        const filesView = selectFilesView(selectorState, {
            listWidth: previewWidth,
            previewWidth,
        });
        const availablePanelsHeight = Math.max(9, height - 4);
        const maxListPanelHeight = Math.max(5, Math.min(10, Math.floor(availablePanelsHeight * 0.35)));
        let listPanelHeight = Math.max(5, Math.min(maxListPanelHeight, (filesView.listBodyLines || []).length + 2));
        let previewPanelHeight = Math.max(5, availablePanelsHeight - listPanelHeight - 1);
        const minPreviewPanelHeight = 8;
        if (previewPanelHeight < minPreviewPanelHeight) {
            const deficit = minPreviewPanelHeight - previewPanelHeight;
            listPanelHeight = Math.max(5, listPanelHeight - deficit);
            previewPanelHeight = Math.max(5, availablePanelsHeight - listPanelHeight - 1);
        }
        return {
            contentWidth: previewWidth,
            contentHeight: Math.max(1, previewPanelHeight - 2),
            totalLines: countWrappedRenderableLines(filesView.previewLines, previewWidth),
        };
    }

    getPaneMaxScrollOffset(pane, state = this.getState()) {
        if (!pane) return 0;
        if (pane === "chat") {
            const metrics = this.getActiveChatRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        if (pane === "activity") {
            const metrics = this.getActivityRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        if (pane === "inspector") {
            const metrics = this.getInspectorRenderMetrics(state);
            const stickyLineCount = Math.min(metrics.contentHeight, metrics.stickyLineCount || 0);
            const scrollableHeight = Math.max(0, metrics.contentHeight - stickyLineCount);
            return Math.max(0, metrics.totalLines - scrollableHeight);
        }
        if (pane === "filePreview") {
            const metrics = this.getFilePreviewRenderMetrics(state);
            return Math.max(0, metrics.totalLines - metrics.contentHeight);
        }
        return 0;
    }

    async maybeAutoExpandActiveHistory(targetOffset, options = {}) {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const currentHistory = state.history.bySessionId.get(sessionId);
        if (!currentHistory?.hasOlderEvents) return;
        if (this.sessionHistoryExpansionLoads.has(sessionId)) return;
        if (Number(currentHistory.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP) {
            this.dispatch({
                type: "ui/status",
                text: "Reached automatic history limit. Press e to load more older CMS events.",
            });
            return;
        }

        // The scroll-position gate compares a DOM-derived target offset with
        // ui-core render metrics, and the two disagree on narrow viewports.
        // Skip it when the caller vouches for the gesture (options.force: an
        // explicit touch pull at the top of the pane) or when the transcript
        // has no real chat messages (splash-only: tall art inflates
        // totalLines past the viewport, so the gate can never pass).
        const hasChatMessages = Array.isArray(currentHistory?.chat) && currentHistory.chat.length > 0;
        if (!options.force && hasChatMessages) {
            const { contentHeight, totalLines } = this.getActiveChatRenderMetrics(state);
            const maxOffset = Math.max(0, totalLines - contentHeight);
            if (targetOffset < maxOffset) return;
        }

        await this.expandSessionHistory(sessionId, {
            requestedScrollOffset: targetOffset,
            autoTriggered: true,
            pages: options.pages,
            // Chat-driven pull: page backward over renderable message types
            // only, so each page is transcript instead of raw event noise.
            eventTypes: CHAT_HISTORY_EVENT_TYPES,
        });
    }

    async expandSessionHistory(sessionId, options = {}) {
        if (!sessionId) return;
        if (this.sessionHistoryExpansionLoads.has(sessionId)) {
            return this.sessionHistoryExpansionLoads.get(sessionId);
        }

        const stateBefore = this.getState();
        const currentHistory = stateBefore.history.bySessionId.get(sessionId);
        const currentLimit = Math.max(
            DEFAULT_HISTORY_EVENT_LIMIT,
            Number(currentHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
        );
        const pageLimit = DEFAULT_HISTORY_EVENT_LIMIT;
        const oldestSeq = Array.isArray(currentHistory?.events) && currentHistory.events.length > 0
            ? Number(currentHistory.events[0]?.seq || 0)
            : 0;

        if (!currentHistory?.hasOlderEvents || oldestSeq <= 1) {
            this.dispatch({
                type: "ui/status",
                text: "Already showing the oldest loaded history",
            });
            return;
        }

        const preserveChatView = sessionId === stateBefore.sessions.activeSessionId;
        const previousScrollOffset = Number(options.requestedScrollOffset ?? stateBefore.ui.scroll?.chat ?? 0);
        const previousRenderedLines = preserveChatView
            ? this.getActiveChatRenderMetrics(stateBefore).totalLines
            : 0;

        const loadPromise = (async () => {
            let history;
            const pagesToLoad = Math.max(1, Math.floor(Number(options.pages) || 1));
            // Optional server-side type filter (chat pull passes the renderable
            // message types). A short/empty filtered page means the transcript
            // is complete, so exhausting it clears hasOlderEvents like a raw
            // page would. Servers without filter support return unfiltered
            // pages, which this loop already handles (today's raw paging).
            const eventTypes = Array.isArray(options.eventTypes) && options.eventTypes.length > 0
                ? options.eventTypes
                : undefined;
            if (typeof this.transport.getSessionEventsBefore === "function" && oldestSeq > 0) {
                history = currentHistory || buildHistoryModel([], { requestedLimit: currentLimit });
                for (let pageIndex = 0; pageIndex < pagesToLoad; pageIndex += 1) {
                    const pageOldestSeq = Array.isArray(history?.events) && history.events.length > 0
                        ? Number(history.events[0]?.seq || 0)
                        : 0;
                    if (!history?.hasOlderEvents || pageOldestSeq <= 1) {
                        history = {
                            ...history,
                            hasOlderEvents: false,
                        };
                        break;
                    }
                    if (Number(history.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP) {
                        break;
                    }
                    const olderEvents = await this.transport.getSessionEventsBefore(sessionId, pageOldestSeq, pageLimit, eventTypes);
                    if (!Array.isArray(olderEvents) || olderEvents.length === 0) {
                        history = {
                            ...history,
                            hasOlderEvents: false,
                        };
                        break;
                    }
                    const olderHistory = buildHistoryModel(olderEvents, { requestedLimit: pageLimit });
                    const combinedEvents = [
                        ...(olderHistory.events || []),
                        ...(history?.events || []),
                    ];
                    history = {
                        chat: dedupeChatMessages([
                            ...(olderHistory.chat || []),
                            ...(history?.chat || []),
                        ]),
                        activity: [
                            ...(olderHistory.activity || []),
                            ...(history?.activity || []),
                        ],
                        events: combinedEvents,
                        lastSeq: history?.lastSeq || history?.events?.[history?.events?.length - 1]?.seq || olderEvents[olderEvents.length - 1]?.seq || 0,
                        loadedEventLimit: combinedEvents.length,
                        loadedEventCount: combinedEvents.length,
                        hasOlderEvents: olderEvents.length >= pageLimit && Number(olderEvents[0]?.seq || 0) > 1,
                    };
                    if (!history.hasOlderEvents) break;
                }
            } else {
                const nextLimit = getNextHistoryEventLimit(currentLimit);
                if (nextLimit <= currentLimit) {
                    this.dispatch({
                        type: "ui/status",
                        text: currentHistory?.hasOlderEvents
                            ? `Already showing a large recent history window (${currentLimit} events)`
                            : "Already showing the oldest loaded history",
                    });
                    return;
                }
                const events = await this.transport.getSessionEvents(sessionId, undefined, nextLimit);
                history = {
                    ...buildHistoryModel(events, { requestedLimit: nextLimit }),
                    lastSeq: events[events.length - 1]?.seq || 0,
                };
            }
            this.dispatch({
                type: "history/set",
                sessionId,
                history,
            });
            for (const event of history?.events || []) {
                this.reconcileOutboxAgainstEvent(sessionId, event);
            }

            const hadChatBefore = Array.isArray(currentHistory?.chat) && currentHistory.chat.length > 0;
            if (preserveChatView && !hadChatBefore) {
                // The splash (or an empty transcript) was showing — there is no
                // reading position to preserve, so land on the latest messages
                // instead of wherever the offset math would leave the view.
                this.dispatch({
                    type: "ui/scroll",
                    pane: "chat",
                    offset: 0,
                });
            } else if (preserveChatView && previousScrollOffset > 0 && !options.autoTriggered) {
                // EXPLICIT "load older" (the TUI's `e`): jump up to the start
                // of what was just fetched — the user asked to SEE it.
                const nextState = this.getState();
                const nextRenderedLines = this.getActiveChatRenderMetrics(nextState).totalLines;
                const addedLines = Math.max(0, nextRenderedLines - previousRenderedLines);
                if (addedLines > 0) {
                    this.dispatch({
                        type: "ui/scroll",
                        pane: "chat",
                        offset: previousScrollOffset + addedLines,
                    });
                }
            }
            // AUTO-triggered (scrolling reached the top): change NOTHING. The
            // offset is distance-from-BOTTOM, which prepended content cannot
            // move — leaving it alone keeps the viewport glued to the exact
            // messages the user was reading, and they scroll on into the new
            // page naturally. Adding the delta here teleported the view to
            // the TOP of a 3.3x-larger window — observed as "loading history
            // takes you way back instead of a few pages up".

            const stateLabel = history.hasOlderEvents
                ? options.autoTriggered
                    ? `Loaded older history page from CMS (${history.loadedEventCount} events loaded)`
                    : `Loaded older history page (${history.loadedEventCount} events loaded)`
                : `Loaded full available history (${history.loadedEventCount} events)`;
            this.dispatch({
                type: "ui/status",
                text: stateLabel,
            });
            if (!history.hasOlderEvents) {
                this.disarmChatTopHistoryLoad();
            } else if (options.autoTriggered && preserveChatView) {
                this.armChatTopHistoryLoad();
            }
        })().finally(() => {
            this.sessionHistoryExpansionLoads.delete(sessionId);
        });

        this.sessionHistoryExpansionLoads.set(sessionId, loadPromise);
        return loadPromise;
    }

    async cancelActiveSession({ confirmed = false } = {}) {
        const state = this.getState();
        const selectedIds = Array.isArray(state.sessions.selectedIds) ? state.sessions.selectedIds : [];
        // In select mode, cancel the explicit selection, even when it contains
        // one row and focus has moved elsewhere.
        if (state.sessions.selectMode && selectedIds.length >= 1) {
            const { eligible, skippedCount } = this.getBulkSelectedSessionActions(state);
            if (eligible.length === 0) {
                this.dispatch({
                    type: "ui/status",
                    text: "No cancellable sessions in selection (system sessions and groups are skipped).",
                });
                return;
            }
            if (!confirmed) {
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Cancel Sessions",
                        message: `Cancel ${eligible.length} selected session${eligible.length === 1 ? "" : "s"}?${skippedCount > 0 ? ` (${skippedCount} selected row${skippedCount === 1 ? "" : "s"} will be skipped)` : ""}`,
                        confirmLabel: "Cancel Sessions",
                        action: "cancelSession",
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            let succeeded = 0;
            const failures = [];
            for (const session of eligible) {
                try {
                    await this.transport.cancelSession(session.sessionId);
                    succeeded += 1;
                } catch (error) {
                    failures.push(`${session.sessionId.slice(0, 8)}: ${error?.message || String(error)}`);
                }
            }
            this.dispatch({ type: "sessions/selectClear" });
            const summary = failures.length === 0
                ? `Cancelled ${succeeded} session${succeeded === 1 ? "" : "s"}`
                : `Cancelled ${succeeded}/${eligible.length}; ${failures.length} failed: ${failures.slice(0, 2).join(", ")}${failures.length > 2 ? "…" : ""}`;
            this.dispatch({ type: "ui/status", text: summary });
            await this.refreshSessions();
            return;
        }

        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const activeSession = state.sessions.byId[sessionId];
        if (activeSession?.isGroup) {
            void confirmed;
            this.dispatch({ type: "ui/status", text: "Groups are containers; cancel sessions individually." });
            return;
        }
        if (activeSession?.isSystem) {
            if (typeof this.transport.restartSystemSession !== "function") {
                this.dispatch({ type: "ui/status", text: "System session restart is not supported by this transport" });
                return;
            }
            if (!confirmed) {
                const label = activeSession.title || activeSession.agentId || sessionId.slice(0, 8);
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Terminate & Restart System Session",
                        message: `Terminate system session "${label}" and start a fresh one?`,
                        confirmLabel: "Terminate & Restart",
                        action: "cancelSession",
                        sessionId,
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            await this.transport.restartSystemSession(activeSession.agentId || sessionId, {
                disposition: "terminate",
                reason: "Terminated by user for system-session restart",
            });
            this.dispatch({ type: "ui/status", text: `Restarted system session ${activeSession.agentId || sessionId.slice(0, 8)}` });
            await this.refreshSessions();
            return;
        }
        if (!confirmed) {
            const session = activeSession;
            const label = session?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Cancel Session",
                    message: `Cancel session "${label}"? The session will stop processing.`,
                    confirmLabel: "Cancel Session",
                    action: "cancelSession",
                    sessionId,
                    previousFocus: state.ui.focusRegion,
                },
            });
            return;
        }
        await this.transport.cancelSession(sessionId);
        this.dispatch({ type: "ui/status", text: `Cancelled ${sessionId.slice(0, 8)}` });
        await this.refreshSessions();
    }

    /**
     * Regenerate the active session's context in place (epoch rebirth): archive
     * the transcript, distill it into a resume package, and rebuild the Copilot
     * session at the next turn boundary. NON-destructive — facts, artifacts,
     * children, sharing, schedule, and chat history are preserved; only the
     * LLM's working context is compacted and recreated. Enqueue-then-observe:
     * the outcome arrives asynchronously as session.regenerate_* / epoch events.
     */
    /**
     * Merge extra inputs (distilling instructions, distill mode) into the open
     * confirm modal. The portal's regenerate confirm renders a textarea + mode
     * select bound here; the TUI renders the same modal as a plain confirm and
     * simply submits the defaults — graceful degradation, no TUI-side wiring.
     */
    updateConfirmExtras(patch) {
        const modal = this.getState().ui.modal;
        if (!modal || modal.type !== "confirm") return;
        this.dispatch({
            type: "ui/modal",
            modal: { ...modal, extras: { ...(modal.extras || {}), ...(patch || {}) } },
        });
    }

    async regenerateActiveSession({
        confirmed = false,
        instructions = "",
        distillMode = "llm",
        distillerModel = "",
        distillerEffort = "",
        distillerContextTier = "",
    } = {}) {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        if (typeof this.transport.regenerateSession !== "function") {
            this.dispatch({ type: "ui/status", text: "Session regeneration is not supported by this deployment" });
            return;
        }
        const activeSession = state.sessions.byId[sessionId];
        if (activeSession?.isGroup) {
            this.dispatch({ type: "ui/status", text: "Groups are containers; regenerate sessions individually." });
            return;
        }
        if (activeSession?.isSystem) {
            this.dispatch({ type: "ui/status", text: "System sessions cannot be regenerated." });
            return;
        }
        if (activeSession?.serviceKind) {
            this.dispatch({ type: "ui/status", text: "Service sessions are runtime machinery and cannot be regenerated." });
            return;
        }
        if (!confirmed) {
            const label = activeSession?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Regenerate Session",
                    message: `Regenerate context for "${label}"? The transcript is archived and distilled, then the session rebuilds fresh from it at the next turn boundary. Facts, artifacts, sub-agents, sharing, schedule, and chat history are preserved. As an operator action this overrides the rate limits (cooldown / minimum age).`,
                    confirmLabel: "Regenerate",
                    action: "regenerateSession",
                    sessionId,
                    previousFocus: state.ui.focusRegion,
                    // Distillation inputs the portal's renderer binds via
                    // updateConfirmExtras; plain-confirm renderers submit these
                    // defaults untouched.
                    extras: {
                        instructions: "",
                        distillMode: "llm",
                        // Empty = deployment default (cluster default model,
                        // model's own default effort/tier). The distiller runs
                        // on machinery config, NOT the served session's model,
                        // so these are explicit choices rather than inherited.
                        distillerModel: "",
                        distillerEffort: "",
                        distillerContextTier: "",
                        distillerModelOptions: await this._loadDistillerModelOptions(),
                    },
                },
            });
            return;
        }
        try {
            // Operator action behind a confirm — force past the soft rate limits
            // (cooldown / min-age). Hard gates (system session, regen in flight)
            // still apply server-side.
            const trimmed = String(instructions || "").trim();
            await this.transport.regenerateSession(sessionId, {
                force: true,
                ...(trimmed ? { instructions: trimmed.slice(0, 4000) } : {}),
                ...(distillMode === "deterministic" ? { distillMode: "deterministic" } : {}),
                ...(distillerModel ? { distillerModel } : {}),
                ...(distillerEffort ? { distillerReasoningEffort: distillerEffort } : {}),
                ...(distillerContextTier ? { distillerContextTier } : {}),
            });
            this.dispatch({ type: "ui/status", text: `Regeneration requested for ${sessionId.slice(0, 8)} — rebuilding at the next boundary` });
        } catch (error) {
            this.dispatch({ type: "ui/status", text: `Regenerate failed: ${error?.message || String(error)}` });
            return;
        }
        await this.refreshSessions();
    }

    /**
     * Model choices for the regen distiller picker: qualified name plus the
     * efforts / context tiers each model actually supports, so the UI can
     * offer only valid combinations. Failure is non-fatal — the picker simply
     * falls back to "deployment default".
     */
    async _loadDistillerModelOptions() {
        if (typeof this.transport.listModels !== "function") return [];
        try {
            // The web transport's listModels() takes no arguments and returns a
            // FLAT model list, while the direct transport can return provider
            // groups. Reading only `group.models` flatMapped the flat shape to
            // nothing, so the portal offered "deployment default" and nothing
            // else — with the catch below hiding it. Accept both shapes.
            const raw = await this.transport.listModels({ groupByProvider: true });
            const top = Array.isArray(raw)
                ? raw
                : (Array.isArray(raw?.providers) ? raw.providers
                    : (Array.isArray(raw?.models) ? raw.models : []));
            const list = top.flatMap((entry) => (
                Array.isArray(entry?.models)
                    ? entry.models.map((m) => ({ ...m, providerId: m.providerId || entry.providerId }))
                    : [entry]
            ));
            return list.filter((model) => model && (model.qualifiedName || model.modelName)).map((model) => ({
                qualifiedName: model.qualifiedName || model.modelName,
                modelName: model.modelName || model.qualifiedName,
                providerId: model.providerId || "",
                supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
                    ? model.supportedReasoningEfforts
                    : [],
                supportedContextTiers: Array.isArray(model.supportedContextTiers)
                    ? model.supportedContextTiers
                    : [],
            }));
        } catch (error) {
            // Previously swallowed silently, which is how an empty picker
            // looked like "no models configured" instead of a failed call.
            this.dispatch({ type: "ui/status", text: `Could not load distiller models: ${error?.message || String(error)}` });
            return [];
        }
    }

    /**
     * Stop the active session's in-flight LLM turn without touching session
     * lifecycle. Applies to user AND system sessions; only group/container
     * rows are rejected. No confirmation modal — the action is non-destructive
     * (the session returns to idle and accepts the next prompt).
     */
    async stopActiveSessionTurn() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const session = state.sessions.byId[sessionId];
        if (!session || session.isGroup) {
            this.dispatch({ type: "ui/status", text: "Select a session to stop its turn." });
            return;
        }
        if (typeof this.transport.stopSessionTurn !== "function") {
            this.dispatch({ type: "ui/status", text: "Stop turn is not supported by this transport" });
            return;
        }
        if (!this._stopTurnInFlight) this._stopTurnInFlight = new Set();
        if (this._stopTurnInFlight.has(sessionId)) return;
        this._stopTurnInFlight.add(sessionId);
        this.dispatch({ type: "ui/status", text: `Stopping turn for ${sessionId.slice(0, 8)}…` });
        try {
            const result = await this.transport.stopSessionTurn(sessionId, { reason: "Stopped by user" });
            const outcome = result?.outcome || "stopped";
            if (outcome === "no_active_turn") {
                this.dispatch({ type: "ui/status", text: "No active turn to stop" });
            } else if (outcome === "timeout") {
                this.dispatch({ type: "ui/status", text: "Stop requested — waiting for the turn to unwind" });
            } else {
                this.dispatch({ type: "ui/status", text: `Stopped turn for ${sessionId.slice(0, 8)}` });
            }
        } catch (err) {
            this.dispatch({ type: "ui/status", text: `Stop turn failed: ${err?.message || err}` });
        } finally {
            this._stopTurnInFlight.delete(sessionId);
        }
        await this.refreshSessions();
        await this.refreshActiveSessionDetail?.().catch?.(() => {});
    }

    togglePinActiveSession() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const session = state.sessions.byId[sessionId];
        if (!session) return;
        if (session.isSystem) {
            this.dispatch({ type: "ui/status", text: "System sessions cannot be pinned." });
            return;
        }
        if (!session.isGroup && (session.parentSessionId || session.groupId)) {
            this.dispatch({ type: "ui/status", text: "Sessions inside groups or parents cannot be pinned." });
            return;
        }
        const isPinned = Array.isArray(state.sessions.pinnedIds) && state.sessions.pinnedIds.includes(sessionId);
        this.dispatch({ type: "sessions/pinToggle", sessionId });
        this.dispatch({
            type: "ui/status",
            text: isPinned
                ? `Unpinned ${sessionId.slice(0, 8)}`
                : `Pinned ${sessionId.slice(0, 8)}`,
        });
    }

    toggleSessionSelectMode() {
        const state = this.getState();
        const enabled = !state.sessions.selectMode;
        this.dispatch({ type: "sessions/selectMode", enabled });
        if (enabled) {
            // Seed the selection with the active session so V immediately
            // gives the user a non-empty selection to act on.
            const activeId = state.sessions.activeSessionId;
            if (activeId && state.sessions.byId[activeId]) {
                this.dispatch({ type: "sessions/selectToggle", sessionId: activeId });
            }
            this.dispatch({ type: "ui/status", text: "Select mode: space toggles, Ctrl+G moves, c cancels, V/esc exits" });
        } else {
            this.dispatch({ type: "ui/status", text: "Select mode off" });
        }
    }

    toggleActiveSessionSelection() {
        const state = this.getState();
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        if (!state.sessions.selectMode) {
            this.dispatch({ type: "sessions/selectMode", enabled: true });
        }
        this.dispatch({ type: "sessions/selectToggle", sessionId });
    }

    setSessionSelection(sessionIds) {
        const ids = Array.isArray(sessionIds) ? sessionIds : [];
        this.dispatch({ type: "sessions/selectSet", sessionIds: ids });
    }

    clearSessionSelection() {
        this.dispatch({ type: "sessions/selectClear" });
    }

    async completeActiveSession(reason = "Completed by user", { confirmed = false } = {}) {
        const state = this.getState();
        const selectedIds = Array.isArray(state.sessions.selectedIds) ? state.sessions.selectedIds : [];
        if (state.sessions.selectMode && selectedIds.length >= 1) {
            const { eligible, skippedCount } = this.getBulkSelectedSessionActions(state);
            if (eligible.length === 0) {
                this.dispatch({ type: "ui/status", text: "No completable sessions in selection (system sessions and groups are skipped)." });
                return;
            }
            if (!confirmed) {
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Complete Sessions",
                        message: `Complete ${eligible.length} selected session${eligible.length === 1 ? "" : "s"}? This will cascade to their sub-agents.${skippedCount > 0 ? ` (${skippedCount} selected row${skippedCount === 1 ? "" : "s"} will be skipped)` : ""}`,
                        confirmLabel: "Complete Sessions",
                        action: "completeSession",
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            let succeeded = 0;
            const failures = [];
            for (const session of eligible) {
                try {
                    await this.transport.completeSession(session.sessionId, reason);
                    succeeded += 1;
                } catch (error) {
                    failures.push(`${session.sessionId.slice(0, 8)}: ${error?.message || String(error)}`);
                }
            }
            this.dispatch({ type: "sessions/selectClear" });
            const summary = failures.length === 0
                ? `Completed ${succeeded} session${succeeded === 1 ? "" : "s"}`
                : `Completed ${succeeded}/${eligible.length}; ${failures.length} failed: ${failures.slice(0, 2).join(", ")}${failures.length > 2 ? "…" : ""}`;
            this.dispatch({ type: "ui/status", text: summary });
            await this.refreshSessions();
            return;
        }
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) return;
        const activeSession = this.getState().sessions.byId[sessionId];
        if (activeSession?.isGroup) {
            void reason;
            void confirmed;
            this.dispatch({ type: "ui/status", text: "Groups are containers; complete sessions individually." });
            return;
        }
        if (activeSession?.isSystem) {
            if (typeof this.transport.restartSystemSession !== "function") {
                this.dispatch({ type: "ui/status", text: "System session restart is not supported by this transport" });
                return;
            }
            if (!confirmed) {
                const label = activeSession.title || activeSession.agentId || sessionId.slice(0, 8);
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Complete & Restart System Session",
                        message: `Mark system session "${label}" complete and start a fresh one?`,
                        confirmLabel: "Complete & Restart",
                        action: "completeSession",
                        sessionId,
                        previousFocus: this.getState().ui.focusRegion,
                    },
                });
                return;
            }
            await this.transport.restartSystemSession(activeSession.agentId || sessionId, {
                disposition: "complete",
                reason,
            });
            this.dispatch({ type: "ui/status", text: `Restarted system session ${activeSession.agentId || sessionId.slice(0, 8)}` });
            await this.refreshSessions();
            return;
        }

        if (typeof this.transport.completeSession !== "function") {
            this.dispatch({ type: "ui/status", text: "Session completion is not supported by this transport" });
            return;
        }
        if (activeSession?.status === "completed" && !activeSession?.cronActive && !activeSession?.cronInterval) {
            this.dispatch({ type: "ui/status", text: `${sessionId.slice(0, 8)} is already completed` });
            return;
        }

        if (!confirmed) {
            const label = activeSession?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Complete Session",
                    message: `Complete session "${label}"? This will cascade to all sub-agents.`,
                    confirmLabel: "Complete",
                    action: "completeSession",
                    sessionId,
                    previousFocus: this.getState().ui.focusRegion,
                },
            });
            return;
        }

        this.dispatch({
            type: "ui/status",
            text: `Completing ${sessionId.slice(0, 8)} (cascading to sub-agents)...`,
        });

        try {
            await this.transport.completeSession(sessionId, reason);
            await this.refreshSessions();
            this.scheduleSessionDetailSync(sessionId, 100);
            this.scheduleSessionsRefresh(900);
        } catch (error) {
            await this.loadSession(sessionId).catch(() => {});
            this.dispatch({
                type: "ui/status",
                text: `Failed to send /done: ${error?.message || String(error)}`,
            });
        }
    }

    async deleteActiveSession({ confirmed = false } = {}) {
        const state = this.getState();
        const selectedIds = Array.isArray(state.sessions.selectedIds) ? state.sessions.selectedIds : [];
        if (state.sessions.selectMode && selectedIds.length >= 1) {
            const { eligible, skippedCount } = this.getBulkSelectedSessionActions(state);
            if (eligible.length === 0) {
                this.dispatch({ type: "ui/status", text: "No deletable sessions in selection (system sessions and groups are skipped)." });
                return;
            }
            if (!confirmed) {
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Hard Delete Sessions",
                        message: `Hard delete ${eligible.length} selected session${eligible.length === 1 ? "" : "s"}? This action cannot be undone.${skippedCount > 0 ? ` (${skippedCount} selected row${skippedCount === 1 ? "" : "s"} will be skipped)` : ""}`,
                        confirmLabel: "Hard Delete Sessions",
                        action: "deleteSession",
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            let succeeded = 0;
            const failures = [];
            for (const session of eligible) {
                try {
                    await this.transport.deleteSession(session.sessionId);
                    this.handleSessionGone(session.sessionId);
                    succeeded += 1;
                } catch (error) {
                    failures.push(`${session.sessionId.slice(0, 8)}: ${error?.message || String(error)}`);
                }
            }
            this.dispatch({ type: "sessions/selectClear" });
            const summary = failures.length === 0
                ? `Deleted ${succeeded} session${succeeded === 1 ? "" : "s"}`
                : `Deleted ${succeeded}/${eligible.length}; ${failures.length} failed: ${failures.slice(0, 2).join(", ")}${failures.length > 2 ? "…" : ""}`;
            this.dispatch({ type: "ui/status", text: summary });
            await this.refreshSessions();
            return;
        }
        const sessionId = state.sessions.activeSessionId;
        if (!sessionId) return;
        const activeSession = state.sessions.byId[sessionId];
        if (activeSession?.isGroup) {
            const groupId = activeSession.groupId || sessionGroupIdFromRowId(sessionId);
            if (!groupId || typeof this.transport.deleteSessionGroup !== "function") {
                this.dispatch({ type: "ui/status", text: "Group deletion is not supported by this transport" });
                return;
            }
            if (Number(activeSession.memberCount || 0) > 0) {
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Group Not Empty",
                        message: `Group "${activeSession.title || groupId}" is not empty. Move all sessions out of the group before deleting it.`,
                        confirmLabel: "OK",
                        action: "alert",
                        alert: true,
                        previousFocus: state.ui.focusRegion,
                    },
                });
                this.dispatch({ type: "ui/status", text: "Move all sessions out of the group before deleting it." });
                return;
            }
            if (!confirmed) {
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Delete Group",
                        message: `Delete empty group "${activeSession.title || groupId}"? This action cannot be undone.`,
                        confirmLabel: "Delete Group",
                        action: "deleteSession",
                        sessionId,
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            await this.transport.deleteSessionGroup(groupId);
            this.dispatch({ type: "ui/status", text: `Deleted group ${activeSession.title || groupId}` });
            await this.refreshSessions();
            return;
        }
        if (activeSession?.isSystem) {
            if (typeof this.transport.restartSystemSession !== "function") {
                this.dispatch({ type: "ui/status", text: "System session restart is not supported by this transport" });
                return;
            }
            if (!confirmed) {
                const label = activeSession.title || activeSession.agentId || sessionId.slice(0, 8);
                this.dispatch({
                    type: "ui/modal",
                    modal: {
                        type: "confirm",
                        title: "Hard Delete & Restart System Session",
                        message: `Hard delete system session "${label}" and start a fresh one? This removes the current orchestration immediately.`,
                        confirmLabel: "Hard Delete & Restart",
                        action: "deleteSession",
                        sessionId,
                        previousFocus: state.ui.focusRegion,
                    },
                });
                return;
            }
            await this.transport.restartSystemSession(activeSession.agentId || sessionId, {
                disposition: "hard_delete",
                reason: "Hard-deleted by user for system-session restart",
            });
            this.dispatch({ type: "ui/status", text: `Restarted system session ${activeSession.agentId || sessionId.slice(0, 8)}` });
            await this.refreshSessions();
            return;
        }
        if (!confirmed) {
            const session = activeSession;
            const label = session?.title || sessionId.slice(0, 8);
            this.dispatch({
                type: "ui/modal",
                modal: {
                    type: "confirm",
                    title: "Delete Session",
                    message: `Delete session "${label}"? This action cannot be undone.`,
                    confirmLabel: "Delete",
                    action: "deleteSession",
                    sessionId,
                    previousFocus: state.ui.focusRegion,
                },
            });
            return;
        }
        await this.transport.deleteSession(sessionId);
        this.handleSessionGone(sessionId);
        this.dispatch({ type: "ui/status", text: `Deleted ${sessionId.slice(0, 8)}` });
        await this.refreshSessions();
    }

    async handleCommand(command) {
        switch (command) {
            case UI_COMMANDS.REFRESH:
                await this.refreshSessions();
                return;
            case UI_COMMANDS.NEW_SESSION:
                await this.openNewSessionFlow();
                return;
            case UI_COMMANDS.OPEN_MODEL_PICKER:
                await this.openModelPicker();
                return;
            case UI_COMMANDS.OPEN_SWITCH_MODEL_PICKER:
                await this.openSwitchModelPicker();
                return;
            case UI_COMMANDS.OPEN_THEME_PICKER:
                this.openThemePicker();
                return;
            case UI_COMMANDS.OPEN_RENAME_SESSION:
                this.openRenameSessionModal();
                return;
            case UI_COMMANDS.CYCLE_SESSION_VISIBILITY:
                await this.cycleSessionVisibility();
                return;
            case UI_COMMANDS.OPEN_SHARE_SESSION:
                await this.openShareSessionModal();
                return;
            case UI_COMMANDS.OPEN_SESSION_FILTER:
                this.openSessionOwnerFilter();
                return;
            case UI_COMMANDS.OPEN_TERMINATE_PICKER:
                await this.openTerminatePickerModal();
                return;
            case UI_COMMANDS.OPEN_MOVE_TO_GROUP:
                await this.openMoveToGroupModal();
                return;
            case UI_COMMANDS.CREATE_SESSION_GROUP:
                await this.openMoveToGroupModal();
                return;
            case UI_COMMANDS.OPEN_ARTIFACT_UPLOAD:
                this.openArtifactUploadModal();
                return;
            case UI_COMMANDS.CLOSE_MODAL:
                this.closeModal();
                return;
            case UI_COMMANDS.MODAL_PREV:
                this.moveModalSelection(-1);
                return;
            case UI_COMMANDS.MODAL_NEXT:
                this.moveModalSelection(1);
                return;
            case UI_COMMANDS.MODAL_PANE_PREV:
                this.moveModalPane(-1);
                return;
            case UI_COMMANDS.MODAL_PANE_NEXT:
                this.moveModalPane(1);
                return;
            case UI_COMMANDS.MODAL_CONFIRM:
                await this.confirmModal();
                return;
            case UI_COMMANDS.SEND_PROMPT:
                await this.sendPrompt();
                return;
            case UI_COMMANDS.FOCUS_NEXT:
                this.focusNext();
                return;
            case UI_COMMANDS.FOCUS_PREV:
                this.focusPrev();
                return;
            case UI_COMMANDS.FOCUS_LEFT:
                this.focusLeft();
                return;
            case UI_COMMANDS.FOCUS_RIGHT:
                this.focusRight();
                return;
            case UI_COMMANDS.FOCUS_PROMPT:
                this.setFocus(FOCUS_REGIONS.PROMPT);
                return;
            case UI_COMMANDS.FOCUS_SESSIONS:
                this.setFocus(FOCUS_REGIONS.SESSIONS);
                return;
            case UI_COMMANDS.MOVE_SESSION_UP:
                await this.moveSession(-1);
                return;
            case UI_COMMANDS.MOVE_SESSION_DOWN:
                await this.moveSession(1);
                return;
            case UI_COMMANDS.EXPAND_SESSION:
                this.expandActiveSession();
                return;
            case UI_COMMANDS.COLLAPSE_SESSION:
                this.collapseActiveSession();
                return;
            case UI_COMMANDS.NEXT_INSPECTOR_TAB:
                this.nextInspectorTab();
                return;
            case UI_COMMANDS.PREV_INSPECTOR_TAB:
                this.prevInspectorTab();
                return;
            case UI_COMMANDS.CYCLE_INSPECTOR_TAB:
                this.cycleInspectorTab();
                return;
            case UI_COMMANDS.GROW_LEFT_PANE:
                this.adjustPaneSplit(8);
                return;
            case UI_COMMANDS.GROW_RIGHT_PANE:
                this.adjustPaneSplit(-8);
                return;
            case UI_COMMANDS.GROW_SESSION_PANE:
                this.adjustSessionPaneSplit(2);
                return;
            case UI_COMMANDS.SHRINK_SESSION_PANE:
                this.adjustSessionPaneSplit(-2);
                return;
            case UI_COMMANDS.GROW_FOCUSED_PANE:
                this.resizeFocusedPane(2);
                return;
            case UI_COMMANDS.SHRINK_FOCUSED_PANE:
                this.resizeFocusedPane(-2);
                return;
            case UI_COMMANDS.OPEN_ARTIFACT_PICKER:
                await this.openArtifactPicker();
                return;
            case UI_COMMANDS.OPEN_HELP:
                this.openHelpModal();
                return;
            case UI_COMMANDS.SEQUENCE_SELECT_PREV:
                this.moveSequenceSelection(-1);
                return;
            case UI_COMMANDS.SEQUENCE_SELECT_NEXT:
                this.moveSequenceSelection(1);
                return;
            case UI_COMMANDS.TOGGLE_SEQUENCE_TURN:
                this.toggleSequenceTurnExpanded();
                return;
            case UI_COMMANDS.TOGGLE_LOG_TAIL:
                this.toggleLogTail();
                return;
            case UI_COMMANDS.TOGGLE_STATS_VIEW:
                this.toggleStatsView();
                return;
            case UI_COMMANDS.OPEN_LOG_FILTER:
                this.openLogFilter();
                return;
            case UI_COMMANDS.OPEN_FILES_FILTER:
                this.openFilesFilter();
                return;
            case UI_COMMANDS.MOVE_FILE_UP:
                await this.moveFileSelection(-1);
                return;
            case UI_COMMANDS.MOVE_FILE_DOWN:
                await this.moveFileSelection(1);
                return;
            case UI_COMMANDS.DOWNLOAD_SELECTED_FILE:
                await this.downloadSelectedArtifact();
                return;
            case UI_COMMANDS.DELETE_SELECTED_FILE:
                await this.deleteSelectedArtifact();
                return;
            case UI_COMMANDS.OPEN_SELECTED_FILE:
                await this.openSelectedFileInDefaultApp();
                return;
            case UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN:
                this.toggleFilePreviewFullscreen();
                return;
            case UI_COMMANDS.TOGGLE_PANE_FULLSCREEN:
                this.toggleFocusedPaneFullscreen();
                return;
            case UI_COMMANDS.SCROLL_UP:
                this.scrollCurrentPane(1);
                return;
            case UI_COMMANDS.SCROLL_DOWN:
                this.scrollCurrentPane(-1);
                return;
            case UI_COMMANDS.PAGE_UP:
                if (this.getState().ui.focusRegion === FOCUS_REGIONS.SESSIONS) {
                    await this.moveSessionPage(-1);
                    return;
                }
                // Focused on the artifact LIST: page the selection, not a
                // scroll offset — the list is the thing being driven there.
                if (this.focusIsArtifactList()) {
                    await this.moveFileSelection(-10);
                    return;
                }
                this.scrollCurrentPane(10);
                return;
            case UI_COMMANDS.PAGE_DOWN:
                if (this.getState().ui.focusRegion === FOCUS_REGIONS.SESSIONS) {
                    await this.moveSessionPage(1);
                    return;
                }
                if (this.focusIsArtifactList()) {
                    await this.moveFileSelection(10);
                    return;
                }
                this.scrollCurrentPane(-10);
                return;
            case UI_COMMANDS.EXPAND_HISTORY:
                await this.expandActiveHistory();
                return;
            case UI_COMMANDS.SCROLL_TOP:
                this.scrollCurrentPaneToTop();
                return;
            case UI_COMMANDS.SCROLL_BOTTOM:
                this.scrollCurrentPaneToBottom();
                return;
            case UI_COMMANDS.CANCEL_SESSION:
                await this.cancelActiveSession();
                return;
            case UI_COMMANDS.STOP_TURN:
                await this.stopActiveSessionTurn();
                return;
            case UI_COMMANDS.DONE_SESSION:
                await this.completeActiveSession();
                return;
            case UI_COMMANDS.DELETE_SESSION:
                await this.deleteActiveSession();
                return;
            case UI_COMMANDS.REGENERATE_SESSION:
                await this.regenerateActiveSession();
                return;
            case UI_COMMANDS.PIN_SESSION:
                this.togglePinActiveSession();
                return;
            case UI_COMMANDS.TOGGLE_SELECT_MODE:
                this.toggleSessionSelectMode();
                return;
            case UI_COMMANDS.TOGGLE_SESSION_SELECTION:
                this.toggleActiveSessionSelection();
                return;
            case UI_COMMANDS.CLEAR_SESSION_SELECTION:
                this.clearSessionSelection();
                return;
            case UI_COMMANDS.OPEN_HISTORY_FORMAT:
                this.openHistoryFormat();
                return;
            case UI_COMMANDS.REFRESH_EXECUTION_HISTORY: {
                const sessionId = this.getState().sessions.activeSessionId;
                if (sessionId) {
                    await this.ensureExecutionHistory(sessionId, { force: true });
                }
                return;
            }
            case UI_COMMANDS.EXPORT_EXECUTION_HISTORY: {
                await this.exportExecutionHistory();
                return;
            }
            case UI_COMMANDS.OPEN_ADMIN_CONSOLE:
                await this.openAdminConsole();
                return;
            case UI_COMMANDS.CLOSE_ADMIN_CONSOLE:
                this.closeAdminConsole();
                return;
            case UI_COMMANDS.ADMIN_REFRESH_PROFILE:
                await this.refreshAdminProfile();
                return;
            case UI_COMMANDS.ADMIN_SHOW_GHCP:
                // Compatibility command retained for older hosts; the visible
                // destination is now Model Providers.
                this.setAdminSection("providers");
                return;
            case UI_COMMANDS.ADMIN_SHOW_PACKAGES:
                this.setAdminSection("packages");
                return;
            case UI_COMMANDS.ADMIN_SHOW_WORKERS:
                this.setAdminSection("workers");
                return;
            case UI_COMMANDS.ADMIN_WORKERS_REFRESH:
                await this.refreshAdminWorkers();
                return;
            case UI_COMMANDS.ADMIN_PACKAGES_REFRESH:
                await this.refreshAdminAgentPackages();
                return;
            case UI_COMMANDS.ADMIN_PACKAGES_NEXT:
                await this.stepAdminPackageSelection(1);
                return;
            case UI_COMMANDS.ADMIN_PACKAGES_PREV:
                await this.stepAdminPackageSelection(-1);
                return;
            case UI_COMMANDS.ADMIN_BEGIN_EDIT_GHCP_KEY:
                this.beginAdminEditGhcpKey();
                return;
            case UI_COMMANDS.ADMIN_CANCEL_EDIT_GHCP_KEY:
                this.cancelAdminEditGhcpKey();
                return;
            case UI_COMMANDS.ADMIN_SAVE_GHCP_KEY:
                await this.saveAdminGhcpKey();
                return;
            case UI_COMMANDS.ADMIN_CLEAR_GHCP_KEY:
                await this.clearAdminGhcpKey();
                return;
            default:
                return;
        }
    }

    async exportExecutionHistory() {
        const sessionId = this.getState().sessions.activeSessionId;
        if (!sessionId) {
            this.dispatch({ type: "ui/status", text: "No session selected." });
            return;
        }
        if (typeof this.transport.exportExecutionHistory !== "function") {
            this.dispatch({ type: "ui/status", text: "History export is not supported by this transport." });
            return;
        }
        this.dispatch({ type: "ui/status", text: "Exporting execution history..." });
        try {
            const result = await this.transport.exportExecutionHistory(sessionId);
            if (result?.filename) {
                await this.ensureFilesForSession(sessionId, { force: true }).catch(() => null);
                this.dispatch({
                    type: "files/select",
                    sessionId,
                    filename: result.filename,
                });
                this.dispatch({
                    type: "files/selectGlobal",
                    artifactId: `${sessionId}/${result.filename}`,
                });
                await this.ensureFilePreview(sessionId, result.filename, { force: true }).catch(() => null);
            }
            this.dispatch({
                type: "ui/status",
                text: result?.filename
                    ? `History saved as artifact ${result.filename}`
                    : `History exported → ${result?.artifactLink || "artifact created"}`,
            });
        } catch (error) {
            this.dispatch({
                type: "ui/status",
                text: `Export failed: ${error?.message || String(error)}`,
            });
        }
    }
}
