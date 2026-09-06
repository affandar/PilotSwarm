import { normalizeMoa } from "./moa.js";
import { retainSessionWarnings } from "./session-errors.js";
import { buildSessionTree, isManuallyOrderableSession } from "./session-tree.js";
import { FOCUS_REGIONS } from "./commands.js";
import { DEFAULT_HISTORY_EVENT_LIMIT, dedupeChatMessages } from "./history.js";
import { getPromptInputRows } from "./layout.js";
import { SYSTEM_OWNER_KEY, ownerKeyForOwner, selectSessionRows } from "./selectors.js";
import { systemSessionSortOrder } from "./system-titles.js";
import {
    normalizeArtifactEntries,
    normalizeSessionOwnerFilter,
    normalizeSessionPause,
    normalizeStoredActiveSessionId,
    normalizeStoredCanvasPrefs,
    canvasKey,
    parseCanvasKey,
    normalizeStoredCollapsedSessionIds,
    normalizeStoredDesktopPanes,
    normalizeStoredLayoutAdjustments,
    normalizeStoredPinnedSessionIds,
    normalizeStoredSessionOrder,
    BUDGET_SERIES_DAYS,
    BUDGET_SERIES_RANGES,
    createInitialState,
    SESSION_VIEW_LAYOUT_KEYS,
    defaultSessionView,
    normalizeStoredSessionViews,
} from "./state.js";

/**
 * Is this package detail/tree/changelog response for a selection the user has
 * already left? Responses carry the selectionSeq captured when their fetch
 * started; the NAME alone cannot tell two copies of a shadowed name apart
 * (scope shadowing: one name, two packages), so a name-only guard let a slow
 * response for one copy land on top of the other. Name-only actions (older
 * hosts) keep the historical name compare.
 */
function packageResponseIsStale(packages, action) {
    if (packages.selectedName !== action.name) return true;
    if (typeof action.seq === "number") return (packages.selectionSeq ?? 0) !== action.seq;
    return false;
}

/** A provider name, or null. Names are cluster-unique and never blank. */
function normalizeProviderName(value) {
    const name = String(value ?? "").trim();
    return name ? name : null;
}

function cloneHistoryMap(historyMap) {
    return new Map(historyMap);
}

function cloneCollapsedIds(collapsedIds) {
    return new Set(collapsedIds);
}

function clonePinnedIds(pinnedIds) {
    return Array.isArray(pinnedIds) ? [...pinnedIds] : [];
}

function cloneSelectedIds(selectedIds) {
    return Array.isArray(selectedIds) ? [...selectedIds] : [];
}

const ROW_VISUAL_STATUS_HOLD_MS = 5000;

function pruneIdList(ids, byId) {
    const out = [];
    const seen = new Set();
    for (const id of ids || []) {
        if (!id || seen.has(id)) continue;
        if (!byId[id]) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function isPinnableSession(session) {
    return Boolean(
        session
        && !session.isSystem
        && (session.isGroup || (!session.parentSessionId && !session.groupId)),
    );
}

/**
 * Keep a pin unless the row is loaded AND demonstrably no longer pinnable.
 *
 * Same rule, and the same reasoning, as pruneCollapsedIds below: a row missing
 * from the current listing has NOT been unpinned. Not-loaded, filtered out,
 * on another page, or simply slower to arrive are indistinguishable from here,
 * and none of them is the user changing their mind.
 *
 * This ran unguarded on every `sessions/loaded`, so any listing that did not
 * happen to contain the pinned row dropped the pin — and because pinnedIds is
 * a dependency of the profile-save effect, the emptied list was then written
 * back to the server as the user's preference. That is a one-way ratchet: the
 * pin did not survive a restart, and the destroyed preference propagated to
 * every other device, which is why a pin set on the desktop never reached the
 * phone.
 *
 * A session that is genuinely present and NOT pinnable (moved into a group or
 * under a parent, or a system row) is a real signal, so that still drops.
 */
function prunePinnedIds(ids, byId) {
    const out = [];
    const seen = new Set();
    for (const id of ids || []) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const session = byId?.[id];
        // Absent from this listing tells us nothing — keep it. A stale id
        // matches no row and hoists nothing; a wrongly dropped one costs the
        // user their pin permanently.
        if (!session || isPinnableSession(session)) out.push(id);
    }
    return out;
}

/**
 * Fold a freshly applied profile's canvasPrefs over the local map. Two rules:
 *
 * - `lastViewedRev` merges by MAX. A poll snapshotted before a local view and
 *   applied after must not regress what this window has already seen — same
 *   monotonicity the revision counter itself keeps.
 * - Entries prune like pins: absent-from-listing proves nothing (the listing
 *   is paged), but a session PRESENT as a child or group can never have a
 *   canvas, and a default-valued entry ({optedOut:false, lastViewedRev:0})
 *   says nothing worth storing. Both drop, which is what keeps the map from
 *   growing one dead key per session forever.
 */
function mergeCanvasPrefs(local, stored, byId) {
    const out = {};
    const keys = new Set([...Object.keys(stored || {}), ...Object.keys(local || {})]);
    for (const sessionId of keys) {
        const storedEntry = (stored || {})[sessionId];
        const localEntry = (local || {})[sessionId];
        const merged = {
            // A local-only entry (viewed since the poll was snapshotted) must
            // survive the apply — dropping it un-views what this window saw.
            optedOut: storedEntry ? storedEntry.optedOut : Boolean(localEntry?.optedOut),
            lastViewedRev: Math.max(storedEntry?.lastViewedRev || 0, localEntry?.lastViewedRev || 0),
            lastViewedDataRev: Math.max(storedEntry?.lastViewedDataRev || 0, localEntry?.lastViewedDataRev || 0),
            // Latest write wins is unknowable here; the local value is the one
            // this window just dragged, so it outranks the poll.
            ...((localEntry?.zenRailPx || storedEntry?.zenRailPx)
                ? { zenRailPx: localEntry?.zenRailPx || storedEntry?.zenRailPx }
                : {}),
        };
        if (!merged.optedOut && merged.lastViewedRev === 0 && merged.lastViewedDataRev === 0 && !merged.zenRailPx) continue;
        const session = byId?.[parseCanvasKey(sessionId).sessionId];
        if (session && session.isGroup) continue;
        out[sessionId] = merged;
    }
    return out;
}


/**
 * Keep a collapse flag unless the session is genuinely gone.
 *
 * "Collapsible" means the row is a folder OR has at least one LOADED child.
 * Sub-agent children arrive lazily, so a parent is routinely not collapsible
 * yet at the moment the profile is applied — dropping its flag there is why
 * parent/sub-agent expansion never survived a reload, while folders (whose
 * rows load with the listing) mostly did.
 *
 * So: a row we cannot currently see keeps its state. Not-loaded, filtered
 * out, on another page, or simply slower to arrive are all indistinguishable
 * from here, and none of them is the user changing their mind. The flag is a
 * preference about a row, not a fact about the current listing.
 *
 * Nothing prunes on deletion either, and deliberately: there is no signal
 * that means "deleted" as opposed to "not in this listing". A row missing
 * from sessions/loaded may have been filtered, paged out, or simply not
 * arrived yet, and treating that as deletion is precisely the bug above. A
 * stale id costs one string and orders nothing; a wrongly dropped one costs
 * the user's layout. If a session really is gone its id is inert, and if it
 * comes back it returns exactly as the user left it.
 *
 * What protects you when something vanishes UNDER you is separate and
 * already here: reconcileCollapsedIdsForActiveSession force-expands every
 * ancestor of the active session, so the row you are actually looking at can
 * never end up hidden inside a collapsed parent.
 */
function pruneCollapsedIds(collapsedIds) {
    // Keeps everything. "Loaded but not collapsible yet" is the common case
    // for a parent whose children have not arrived, so even that cannot be
    // used to drop a flag — which is what made this function's original
    // filter lose parent/sub-agent expansion on every reload.
    return cloneCollapsedIds(collapsedIds);
}


function collectSessionAncestorIds(sessionId, byId) {
    const ancestors = [];
    const seen = new Set([sessionId]);
    let session = byId?.[sessionId] || null;

    while (session) {
        let parentId = null;
        if (session.parentSessionId && byId?.[session.parentSessionId]) {
            parentId = session.parentSessionId;
        } else if (!session.isGroup && session.groupId && byId?.[`group:${session.groupId}`]) {
            parentId = `group:${session.groupId}`;
        }

        if (!parentId || seen.has(parentId)) break;
        ancestors.push(parentId);
        seen.add(parentId);
        session = byId[parentId] || null;
    }

    return ancestors;
}

function reconcileCollapsedIdsForActiveSession(collapsedIds, byId, activeSessionId) {
    const next = pruneCollapsedIds(collapsedIds, byId);
    if (!activeSessionId || !byId?.[activeSessionId]) return next;
    for (const ancestorId of collectSessionAncestorIds(activeSessionId, byId)) {
        next.delete(ancestorId);
    }
    return next;
}

function setsEqual(left, right) {
    if (left === right) return true;
    if (!(left instanceof Set) || !(right instanceof Set)) return false;
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function cloneOrderById(orderById) {
    return { ...(orderById || {}) };
}

function cloneFilesBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function cloneOutboxBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function cloneOrchestrationBySessionId(bySessionId) {
    return { ...(bySessionId || {}) };
}

function normalizeFilesFilter(filter) {
    return {
        scope: filter?.scope === "allSessions" ? "allSessions" : "selectedSession",
        query: typeof filter?.query === "string" ? filter.query : "",
    };
}

function normalizeLogEntries(entries) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return list.slice(-1000);
}

function normalizeFullscreenPane(fullscreenPane) {
    return [
        FOCUS_REGIONS.SESSIONS,
        FOCUS_REGIONS.CHAT,
        FOCUS_REGIONS.INSPECTOR,
        FOCUS_REGIONS.ACTIVITY,
    ].includes(fullscreenPane)
        ? fullscreenPane
        : null;
}

function clampHistoryItems(items, maxItems) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeMax = Math.max(DEFAULT_HISTORY_EVENT_LIMIT, Number(maxItems) || DEFAULT_HISTORY_EVENT_LIMIT);
    return list.length > safeMax ? list.slice(-safeMax) : list;
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

function sessionUpdateTimestampMs(session) {
    const value = session?.updatedAt;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

// True when `nextSession` carries no newer information than what we already
// hold. Both timestamps must be present — an update with no `updatedAt` is
// treated as newer, because we cannot prove otherwise.
function isSameOrOlderSessionUpdate(previousSession, nextSession) {
    const previousAt = sessionUpdateTimestampMs(previousSession);
    const nextAt = sessionUpdateTimestampMs(nextSession);
    return previousAt > 0 && nextAt > 0 && nextAt <= previousAt;
}

// Completion can come from orchestration metadata without another custom
// status write. Allow it at the same version, but never at an older version.
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "cancelled", "error"]);

function sessionStatusVersion(session) {
    const value = session?.statusVersion;
    if (value == null || value === "" || typeof value === "boolean") return null;
    const version = Number(value);
    return Number.isSafeInteger(version) && version > 0 ? version : null;
}

// List polls and detail requests can arrive out of order. Compare the server
// counter in both directions: an old running row must not revive an idle
// session, and an old idle row must not hide a running one. Keep the version
// with its status; accepting an older counter would let the next stale row win.
function shouldPreserveSessionStatus(previousSession, nextSession) {
    const previousVersion = sessionStatusVersion(previousSession);
    const nextVersion = sessionStatusVersion(nextSession);
    if (previousVersion != null && nextVersion != null) {
        if (nextVersion < previousVersion) return true;
        if (nextVersion > previousVersion) return false;
    }
    const previousStatus = previousSession?.status;
    const nextStatus = nextSession?.status;
    if (!previousStatus || !nextStatus || previousStatus === nextStatus
        || TERMINAL_SESSION_STATUSES.has(nextStatus)) return false;
    if (previousVersion != null && nextVersion != null) return true;
    // Legacy rows and live event patches may lack a counter. Do not guess
    // their order without timestamps. Preserve the terminal-status escape
    // hatch, since updatedAt also changes for non-status events.
    if (previousStatus === "running") return isSameOrOlderSessionUpdate(previousSession, nextSession);
    // An unversioned new turn may share its timestamp with the preceding idle
    // row. Equal timestamps alone are not evidence that a start is stale.
    const previousAt = sessionUpdateTimestampMs(previousSession);
    const nextAt = sessionUpdateTimestampMs(nextSession);
    return nextStatus === "running" && previousAt > 0 && nextAt > 0 && nextAt < previousAt;
}

// These values describe the same run as status. Mixing an old question or
// pause reason with a newer status can change composer routing and controls.
const SESSION_STATUS_FIELDS = new Set([
    "status", "statusVersion", "updatedAt", "orchestrationStatus",
    "pendingQuestion", "waitReason", "pauseState", "error", "result",
]);

function mergeDefinedSessionFields(previousSession = {}, nextSession = {}) {
    let merged = previousSession || {};
    const preserveStatus = shouldPreserveSessionStatus(previousSession, nextSession);
    const previousVersion = sessionStatusVersion(previousSession);
    for (const [key, value] of Object.entries(nextSession || {})) {
        if (value === undefined) continue;
        if (preserveStatus && SESSION_STATUS_FIELDS.has(key)) continue;
        // Repeated snapshots of one server version cannot roll its timestamp
        // back and then admit an older unversioned running update.
        if (key === "updatedAt" && previousVersion != null
            && previousVersion === sessionStatusVersion(nextSession)
            && sessionUpdateTimestampMs(nextSession) < sessionUpdateTimestampMs(previousSession)) continue;
        // An absent/invalid counter must not erase the last known server version.
        if (key === "statusVersion" && previousVersion != null
            && sessionStatusVersion(nextSession) == null) continue;
        if (key === "pendingQuestion" && isAnsweredPendingQuestion(previousSession, value)) {
            if (merged === previousSession) {
                merged = { ...(previousSession || {}) };
            }
            merged.pendingQuestion = null;
            continue;
        }
        if (areStructuredValuesEqual(previousSession?.[key], value)) continue;
        if (merged === previousSession) {
            merged = { ...(previousSession || {}) };
        }
        merged[key] = value;
    }
    return merged;
}

// Mirrors selectors' getSessionVisualStatus — the two must agree or the row
// label (debounced, from here) and the summary label (immediate, from there)
// will disagree mid-turn.
function computeRawSessionVisualStatus(session) {
    if (!session) return "unknown";
    const status = session.status || "unknown";
    const dormant = status === "waiting" || status === "idle" || status === "unknown";
    // A budget pause outranks every other dormant reading. A session parked on
    // a limit is not "waiting" in the sense the list means it — nothing is
    // going to happen until a person changes a number — and the row is the
    // only place most people will ever find that out.
    if (dormant && normalizeSessionPause(session)) {
        return "budget_paused";
    }
    if (session.cronActive === true && dormant) {
        return "cron_waiting";
    }
    if (dormant && (Number(session.activeChildCount) || 0) > 0) {
        return "awaiting_children";
    }
    return status;
}

function mergeSessionRowVisualStatus(previousSession, nextSession, nowMs) {
    if (!nextSession?.sessionId || nextSession.isGroup) return nextSession;

    const desiredStatus = computeRawSessionVisualStatus(nextSession);
    const previousDisplayStatus = previousSession?.rowVisualStatus
        || computeRawSessionVisualStatus(previousSession || nextSession);

    if (!previousSession) {
        if (nextSession.rowVisualStatus === desiredStatus
            && nextSession.rowVisualStatusCandidate == null
            && nextSession.rowVisualStatusCandidateSince == null) {
            return nextSession;
        }
        return {
            ...nextSession,
            rowVisualStatus: desiredStatus,
            rowVisualStatusCandidate: undefined,
            rowVisualStatusCandidateSince: undefined,
        };
    }

    if (desiredStatus === previousDisplayStatus) {
        if (nextSession.rowVisualStatus === desiredStatus
            && nextSession.rowVisualStatusCandidate == null
            && nextSession.rowVisualStatusCandidateSince == null) {
            return nextSession;
        }
        return {
            ...nextSession,
            rowVisualStatus: desiredStatus,
            rowVisualStatusCandidate: undefined,
            rowVisualStatusCandidateSince: undefined,
        };
    }

    const previousCandidate = previousSession.rowVisualStatusCandidate;
    const candidateSince = previousCandidate === desiredStatus
        ? Number(previousSession.rowVisualStatusCandidateSince) || nowMs
        : nowMs;

    if (nowMs - candidateSince >= ROW_VISUAL_STATUS_HOLD_MS) {
        return {
            ...nextSession,
            rowVisualStatus: desiredStatus,
            rowVisualStatusCandidate: undefined,
            rowVisualStatusCandidateSince: undefined,
        };
    }

    if (nextSession.rowVisualStatus === previousDisplayStatus
        && nextSession.rowVisualStatusCandidate === desiredStatus
        && Number(nextSession.rowVisualStatusCandidateSince) === candidateSince) {
        return nextSession;
    }

    return {
        ...nextSession,
        rowVisualStatus: previousDisplayStatus,
        rowVisualStatusCandidate: desiredStatus,
        rowVisualStatusCandidateSince: candidateSince,
    };
}

// A sub-agent that finishes its task stays alive and IDLE waiting for follow-up
// (see managed-session's spawn_agent contract), so "has children" says nothing
// about whether work is still happening below. Only these two statuses mean the
// parent is genuinely blocked on someone else.
const ACTIVE_DESCENDANT_STATUSES = new Set(["running", "input_required"]);

/**
 * Stamp `activeChildCount` — the number of running/input_required descendants,
 * at any depth — onto every session that has one. selectors' visual-status
 * derivation reads it to distinguish "idle because it is waiting on its
 * children" from "idle because there is nothing to do".
 *
 * Counted transitively so the whole ancestor chain lights up: without that, a
 * parent whose direct child is itself only waiting on a grandchild would read
 * as plain idle and the delegation would look dead.
 *
 * Returns `byId` unchanged when nothing moved, so this stays free for the
 * common poll that changes nothing.
 */
function applyActiveDescendantCounts(byId) {
    const counts = new Map();
    for (const session of Object.values(byId || {})) {
        if (!session?.sessionId || session.isGroup) continue;
        if (!ACTIVE_DESCENDANT_STATUSES.has(session.status)) continue;
        // A malformed parent chain (self-parent, cycle) would spin forever;
        // `seen` bounds the walk to one visit per ancestor.
        const seen = new Set([session.sessionId]);
        let parentId = session.parentSessionId;
        while (parentId && byId[parentId] && !seen.has(parentId)) {
            seen.add(parentId);
            counts.set(parentId, (counts.get(parentId) || 0) + 1);
            parentId = byId[parentId].parentSessionId;
        }
    }

    let changed = false;
    const next = {};
    for (const [sessionId, session] of Object.entries(byId || {})) {
        const nextCount = counts.get(sessionId) || 0;
        const previousCount = Number(session?.activeChildCount) || 0;
        if (nextCount === previousCount) {
            next[sessionId] = session;
            continue;
        }
        changed = true;
        next[sessionId] = nextCount > 0
            ? { ...session, activeChildCount: nextCount }
            : { ...session, activeChildCount: undefined };
    }
    return changed ? next : byId;
}

/**
 * Run the row-status debounce across a whole map. A session going running or
 * idle moves its ANCESTORS' visual status too (they gain or lose
 * awaiting_children), and those ancestors are not in the payload that caused
 * the change — so the debounce has to be re-evaluated for everyone, not just
 * the rows that arrived.
 */
function applyRowVisualStatuses(previousById = {}, nextById = {}, nowMs) {
    let changed = false;
    const out = {};
    for (const [sessionId, session] of Object.entries(nextById)) {
        const merged = mergeSessionRowVisualStatus(previousById[sessionId], session, nowMs);
        out[sessionId] = merged;
        if (merged !== session) changed = true;
    }
    return changed ? out : nextById;
}

function normalizedPendingQuestionText(pendingQuestion) {
    return String(pendingQuestion?.question || "").trim();
}

function isAnsweredPendingQuestion(previousSession, pendingQuestion) {
    const answeredQuestion = normalizedPendingQuestionText(previousSession?.answeredPendingQuestion);
    const incomingQuestion = normalizedPendingQuestionText(pendingQuestion);
    return Boolean(answeredQuestion && incomingQuestion && answeredQuestion === incomingQuestion);
}

function pickDefaultActiveSessionId(sessions = []) {
    const mainSystem = (sessions || []).find((session) => session?.sessionId && session.isSystem && systemSessionSortOrder(session) === 0);
    if (mainSystem?.sessionId) return mainSystem.sessionId;
    const firstSession = (sessions || []).find((session) => session?.sessionId);
    return firstSession?.sessionId || null;
}

function collectDefaultCollapsedSessionIds(sessions = []) {
    const byId = new Set((sessions || []).map((session) => session?.sessionId).filter(Boolean));
    const collapsedIds = new Set();
    for (const session of sessions || []) {
        if (!session?.sessionId) continue;
        if (session.isGroup) collapsedIds.add(session.sessionId);
        const parentSessionId = session.parentSessionId;
        if (parentSessionId && byId.has(parentSessionId)) {
            collapsedIds.add(parentSessionId);
        }
    }
    return collapsedIds;
}

function hasSessionVisibilityFilter(sessions = {}) {
    const query = String(sessions?.filterQuery || "").trim();
    const ownerFilter = normalizeSessionOwnerFilter(sessions?.ownerFilter);
    return Boolean(query) || ownerFilter.all !== true;
}

function resolveVisibleActiveSessionId(state, fallbackSessions = []) {
    const visibleRows = selectSessionRows(state);
    const currentSessionId = state.sessions?.activeSessionId || null;
    if (currentSessionId && visibleRows.some((row) => row.sessionId === currentSessionId)) {
        return currentSessionId;
    }
    // A navigation intent (deep link) owns selection until it is cleared by
    // manual navigation or a filter change. While one exists — pending target
    // still loading, or failed — never fall back to a default selection.
    if (state.sessions?.navigationIntent) {
        return currentSessionId;
    }
    if (currentSessionId && state.sessions?.byId?.[currentSessionId] && !hasSessionVisibilityFilter(state.sessions)) {
        return currentSessionId;
    }
    // A selection restored from the profile names a session the listing has
    // not delivered yet — the folder listing routinely lands first, so the
    // restored id was judged "not visible" and replaced by the default, which
    // then got saved over it. Hold it until a sessions listing has actually
    // arrived; only then is absence evidence the session is gone.
    if (currentSessionId && !state.sessions?.listingSeen) {
        return currentSessionId;
    }
    if (hasSessionVisibilityFilter(state.sessions)) {
        return visibleRows[0]?.sessionId || null;
    }

    const visibleSessions = visibleRows.length > 0
        ? visibleRows
            .map((row) => state.sessions?.byId?.[row.sessionId] || null)
            .filter(Boolean)
        : fallbackSessions;

    return pickDefaultActiveSessionId(visibleSessions);
}

function updateUiForSessionSelection(state, nextActiveSessionId) {
    if (nextActiveSessionId === state.sessions.activeSessionId) {
        return state.ui;
    }
    return {
        ...state.ui,
        scroll: {
            ...state.ui.scroll,
            chat: 0,
            inspector: 0,
            activity: 0,
        },
        followBottom: {
            ...(state.ui.followBottom || {}),
            inspector: true,
            activity: true,
        },
    };
}

// Add the linked session's owner to the owner filter when that is what hides
// it. Returns the next sessions slice, or null when the owner filter is not
// the reason (an `all` filter, a system or unowned session, an owner the
// filter already admits) so the caller falls back to the transient exception.
function admitLinkedSessionOwner(state, sessions, targetId) {
    const target = sessions.byId?.[targetId];
    if (!target || target.isGroup || target.isSystem) return null;
    const filter = normalizeSessionOwnerFilter(sessions.ownerFilter);
    if (filter.all === true) return null;
    const ownerKey = ownerKeyForOwner(target.owner);
    if (!ownerKey || ownerKey === SYSTEM_OWNER_KEY) return null;
    const viewerKey = ownerKeyForOwner(state.auth?.principal);
    if (viewerKey && ownerKey === viewerKey) return null;
    if (filter.includeShared || filter.ownerKeys.includes(ownerKey)) return null;
    const candidate = {
        ...sessions,
        ownerFilterExplicit: true,
        ownerFilter: { ...filter, ownerKeys: [...filter.ownerKeys, ownerKey] },
        ownerFilterAutoAdmitted: { sessionId: targetId, ownerKey },
    };
    // Prove it worked: a session hidden by something else as well (a text
    // filter, a collapsed ancestor) must not change the filter for nothing.
    const rows = selectSessionRows({ ...state, sessions: candidate });
    return rows.some((row) => row.sessionId === targetId) ? candidate : null;
}

function keepAdmittedOwner(filter, admitted) {
    const ownerKey = admitted?.ownerKey;
    if (!ownerKey || filter.all === true || filter.includeShared || filter.ownerKeys.includes(ownerKey)) return filter;
    return { ...filter, ownerKeys: [...filter.ownerKeys, ownerKey] };
}

function applyVisibleSessionSelection(state, nextSessions) {
    let sessions = nextSessions;

    // Navigation intent (deep link) outranks in-memory selection and profile
    // activeSessionId: once its target session is present, latch the selection
    // onto it and mark the intent resolved.
    const intent = sessions.navigationIntent || null;
    const intentTargetId = intent && intent.status !== "failed" && sessions.byId?.[intent.sessionId]
        ? intent.sessionId
        : null;
    if (intentTargetId) {
        sessions = {
            ...sessions,
            activeSessionId: intentTargetId,
            listDeselected: false,
            navigationIntent: intent.status === "resolved"
                ? intent
                : { sessionId: intent.sessionId, status: "resolved" },
        };
    }

    // Expand ancestors BEFORE resolving visibility: a selected session inside
    // a collapsed group/parent is absent from the flat tree, so resolving
    // first would drop the selection instead of revealing it.
    const selectionCandidateId = sessions.activeSessionId || null;
    if (selectionCandidateId && sessions.byId?.[selectionCandidateId]) {
        const expandedCollapsedIds = reconcileCollapsedIdsForActiveSession(sessions.collapsedIds, sessions.byId, selectionCandidateId);
        if (!setsEqual(expandedCollapsedIds, sessions.collapsedIds)) {
            sessions = {
                ...sessions,
                collapsedIds: expandedCollapsedIds,
                flat: buildSessionTree(Object.values(sessions.byId || {}), expandedCollapsedIds, sessions.orderById, sessions.pinnedIds, sessions.manualOrder),
            };
        }
    }

    // A resolved intent target excluded by the current filters. First choice:
    // when the only thing hiding it is that its owner is not in the owner
    // filter, ADD that owner to the filter. The filter persists with the
    // profile, so the linked session — and that person's other shared
    // sessions — stay listed after the link is gone. Without this the link
    // opened the chat but the row never appeared in the list. Fallback (no
    // human owner, or hidden for another reason): the transient exception,
    // never persisted, cleared on manual navigation or filter change.
    if (intentTargetId && sessions.filterExceptionId !== intentTargetId
        && sessions.ownerFilterAutoAdmitted?.sessionId !== intentTargetId) {
        const probeRows = selectSessionRows({ ...state, sessions });
        if (!probeRows.some((row) => row.sessionId === intentTargetId)) {
            const admitted = admitLinkedSessionOwner(state, sessions, intentTargetId);
            if (admitted) {
                sessions = admitted;
            } else {
                sessions = {
                    ...sessions,
                    filterExceptionId: intentTargetId,
                };
            }
        }
    }

    const nextState = {
        ...state,
        sessions,
    };
    const nextActiveSessionId = resolveVisibleActiveSessionId(nextState, Object.values(sessions.byId || {}));
    const nextCollapsedIds = reconcileCollapsedIdsForActiveSession(sessions.collapsedIds, sessions.byId, nextActiveSessionId);
    const collapsedChanged = !setsEqual(nextCollapsedIds, sessions.collapsedIds);
    const reconciledSessions = collapsedChanged
        ? {
            ...sessions,
            collapsedIds: nextCollapsedIds,
            flat: buildSessionTree(Object.values(sessions.byId || {}), nextCollapsedIds, sessions.orderById, sessions.pinnedIds, sessions.manualOrder),
        }
        : sessions;
    return {
        sessions: {
            ...reconciledSessions,
            activeSessionId: nextActiveSessionId,
        },
        ui: updateUiForSessionSelection(state, nextActiveSessionId),
    };
}

function assignStableSessionOrder(previousOrderById = {}, nextOrderOrdinal = 0, sessions = []) {
    const orderById = cloneOrderById(previousOrderById);
    let orderOrdinal = Number.isFinite(nextOrderOrdinal) ? nextOrderOrdinal : 0;

    for (const session of sessions || []) {
        const sessionId = session?.sessionId;
        if (!sessionId) continue;
        if (typeof orderById[sessionId] === "number") continue;
        orderById[sessionId] = orderOrdinal;
        orderOrdinal += 1;
    }

    return {
        orderById,
        nextOrderOrdinal: orderOrdinal,
    };
}

function assignInitialSessionOrder(sessions = [], pinnedIds = []) {
    const expandedFlat = buildSessionTree(sessions, new Set(), {}, pinnedIds);
    const orderById = {};
    let orderOrdinal = 0;

    for (const entry of expandedFlat) {
        const sessionId = entry?.sessionId;
        if (!sessionId || typeof orderById[sessionId] === "number") continue;
        orderById[sessionId] = orderOrdinal;
        orderOrdinal += 1;
    }

    for (const session of sessions || []) {
        const sessionId = session?.sessionId;
        if (!sessionId || typeof orderById[sessionId] === "number") continue;
        orderById[sessionId] = orderOrdinal;
        orderOrdinal += 1;
    }

    return {
        orderById,
        nextOrderOrdinal: orderOrdinal,
    };
}

function clampPromptCursor(prompt, cursor, fallback = null) {
    const text = String(prompt || "");
    const preferred = Number.isFinite(cursor)
        ? cursor
        : (Number.isFinite(fallback) ? fallback : text.length);
    return Math.max(0, Math.min(preferred, text.length));
}

function normalizePromptAttachments(prompt, attachments) {
    const safePrompt = String(prompt || "");
    const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    return list.filter((attachment) => {
        // Image attachments are chip-managed (staged File objects, no inline
        // token in the prompt) — they live until sent or explicitly removed.
        if (attachment?.kind === "image") return true;
        const token = String(attachment?.token || "").trim();
        return token && safePrompt.includes(token);
    });
}

export function appReducer(state, action) {
    const sessionId = action.sessionId ?? action.session?.sessionId;
    const contentUpdate = /^(history|files|canvas|orchestration|executionHistory|sessionStats|outbox)\//.test(action.type) || action.type === "sessions/merged";
    if (sessionId && contentUpdate && state.sessions?.goneIds?.includes(sessionId)) return state;
    const next = baseReducer(state, action);
    if (next === state) return next;
    return reconcileSessionView(state, next, action);
}

// Per-session desktop views, kept in step with the ui slice.
//
//   active session changed  → apply that session's stored view (or the
//                             default: no columns, even sizes)
//   profile settings applied → re-apply the active session's view, so the
//                             global desktopPanes/layoutAdjustments a poll
//                             carries never override a per-session choice
//   anything else changed a column toggle or a right-side size while the
//   session stayed the same → record it for that session
//
// Desktop only (the phone has no columns; its layout is untouched), and only
// once the profile has been read, so the defaults cannot be recorded over a
// stored view the tab has not seen yet.
function reconcileSessionView(prev, next, action) {
    const ui = next.ui;
    if (ui.sessionViewDevice !== "desktop") return next;
    const active = next.sessions.activeSessionId || null;
    if (!active || next.sessions.byId?.[active]?.isGroup) return next;
    const prevActive = prev.sessions.activeSessionId || null;
    // A profile read (the first one included) re-applies the active
    // session's view from the merged map. Local edits made before the read
    // were recorded below and win the merge, so a column opened while the
    // profile was still loading is not shut by the answer.
    if (action.type === "profileSettings/apply") {
        return { ...next, ui: applySessionViewToUi(ui, ui.sessionViews?.[active]?.desktop || defaultSessionView()) };
    }
    if (active !== prevActive) {
        // Before the read there is nothing to apply on a switch; the stored
        // view lands with the read.
        if (!ui.sessionViewsLoaded) return next;
        return { ...next, ui: applySessionViewToUi(ui, ui.sessionViews?.[active]?.desktop || defaultSessionView()) };
    }
    const current = sessionViewFromUi(ui);
    const before = sessionViewFromUi(prev.ui);
    if (sessionViewsEqual(current, before)) return next;
    const entry = { ...(ui.sessionViews?.[active] || {}), desktop: { ...current, at: Date.now() } };
    return {
        ...next,
        ui: {
            ...ui,
            sessionViews: { ...(ui.sessionViews || {}), [active]: entry },
        },
    };
}

function sessionViewFromUi(ui) {
    const layout = {};
    for (const key of SESSION_VIEW_LAYOUT_KEYS) layout[key] = Number(ui.layout?.[key]) || 0;
    return {
        canvasOpen: ui.canvasOpen === true,
        diagnosticsOpen: ui.diagnosticsOpen === true,
        zen: ui.canvasOpen === true && ui.canvasZen === true,
        layout,
    };
}

function sessionViewsEqual(a, b) {
    if (a.canvasOpen !== b.canvasOpen || a.diagnosticsOpen !== b.diagnosticsOpen || a.zen !== b.zen) return false;
    for (const key of SESSION_VIEW_LAYOUT_KEYS) if (a.layout[key] !== b.layout[key]) return false;
    return true;
}

function applySessionViewToUi(ui, view) {
    const current = sessionViewFromUi(ui);
    const wanted = { canvasOpen: view.canvasOpen === true, diagnosticsOpen: view.diagnosticsOpen === true, zen: view.canvasOpen === true && view.zen === true, layout: view.layout || {} };
    if (sessionViewsEqual(current, { ...wanted, layout: { ...current.layout, ...wanted.layout } })) return ui;
    return {
        ...ui,
        canvasOpen: wanted.canvasOpen,
        diagnosticsOpen: wanted.diagnosticsOpen,
        canvasZen: wanted.zen,
        rightPaneMode: wanted.canvasOpen ? "canvas" : "panes",
        ...(wanted.canvasOpen ? {} : { canvasMaximized: false }),
        layout: { ...(ui.layout || {}), ...wanted.layout },
    };
}

// Newest wins, per session: every record carries the time it was made, so a
// local edit newer than the stored one survives the poll, and another
// desktop's later edit replaces this tab's older one. No "touched" set —
// one that never cleared made two desktops fight over the same session.
function mergeSessionViews(remote, local) {
    const out = { ...(remote || {}) };
    for (const [id, entry] of Object.entries(local || {})) {
        const localAt = Number(entry?.desktop?.at) || 0;
        const remoteAt = Number(out[id]?.desktop?.at) || 0;
        if (!out[id] || localAt > remoteAt) out[id] = entry;
    }
    return out;
}

function baseReducer(state, action) {
    switch (action.type) {
        case "connection/ready":
            return {
                ...state,
                connection: {
                    ...state.connection,
                    connected: true,
                    workersOnline: action.workersOnline ?? state.connection.workersOnline,
                    error: null,
                },
                ui: {
                    ...state.ui,
                    statusText: action.statusText ?? state.ui.statusText ?? "Ready",
                },
            };

        case "connection/error":
            return {
                ...state,
                connection: {
                    ...state.connection,
                    connected: false,
                    error: action.error,
                },
                ui: {
                    ...state.ui,
                    statusText: action.statusText || action.error || "Connection error",
                },
            };

        case "auth/context":
            return {
                ...state,
                auth: {
                    principal: action.principal ?? null,
                    authorization: action.authorization ?? null,
                },
            };

        case "ui/status":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    statusText: action.text,
                },
            };

        case "ui/theme":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    themeId: action.themeId || state.ui.themeId,
                },
            };

        case "ui/sessionViewDevice": {
            const device = action.device === "desktop" || action.device === "mobile" ? action.device : null;
            if (device === state.ui.sessionViewDevice) return state;
            return { ...state, ui: { ...state.ui, sessionViewDevice: device } };
        }

        case "ui/touchScale":
            if (Boolean(action.enabled) === Boolean(state.ui.touchScale)) return state;
            return { ...state, ui: { ...state.ui, touchScale: Boolean(action.enabled) } };

        case "ui/agentPickerUsage": {
            const usage = action.usage && typeof action.usage === "object" && !Array.isArray(action.usage)
                ? action.usage
                : {};
            return { ...state, ui: { ...state.ui, agentPickerUsage: usage } };
        }

        case "ui/sessionDetailCollapsed":
            if (Boolean(action.collapsed) === Boolean(state.ui.sessionDetailCollapsed)) return state;
            return { ...state, ui: { ...state.ui, sessionDetailCollapsed: Boolean(action.collapsed) } };

        case "ui/moaSaveStatus":
            return { ...state, ui: { ...state.ui, moaSaveStatus: action.status, moaDirty: action.status === "saved" && state.ui.moaRevision === action.revision ? false : state.ui.moaDirty } };
        case "ui/moa":
            return { ...state, ui: { ...state.ui, moa: normalizeMoa(action.value), moaDirty: true, moaRevision: (state.ui.moaRevision || 0) + 1 } };
        case "profileSettings/apply": {
            const settings = action.settings && typeof action.settings === "object" && !Array.isArray(action.settings)
                ? action.settings
                : {};
            const hasTheme = Object.prototype.hasOwnProperty.call(settings, "themeId")
                && typeof settings.themeId === "string"
                && settings.themeId.trim();
            const hasOwnerFilter = Object.prototype.hasOwnProperty.call(settings, "sessionOwnerFilter");
            const hasLayout = Object.prototype.hasOwnProperty.call(settings, "layoutAdjustments");
            // "rich" was retired as a view mode — stored profiles that still
            // say "rich" fall through to the transcript below.
            const hasTouchScale = Object.prototype.hasOwnProperty.call(settings, "touchScale")
                && typeof settings.touchScale === "boolean";
            const hasSessionDetailCollapsed = Object.prototype.hasOwnProperty.call(settings, "sessionDetailCollapsed")
                && typeof settings.sessionDetailCollapsed === "boolean";
            const hasAgentPickerUsage = Object.prototype.hasOwnProperty.call(settings, "agentPickerUsage")
                && settings.agentPickerUsage && typeof settings.agentPickerUsage === "object"
                && !Array.isArray(settings.agentPickerUsage);
            const hasRightPaneMode = Object.prototype.hasOwnProperty.call(settings, "rightPaneMode")
                && (settings.rightPaneMode === "canvas" || settings.rightPaneMode === "panes");
            // The two independent columns. A profile written by a build that
            // predates them carries only rightPaneMode, so fall back to
            // migrating that — see normalizeStoredDesktopPanes.
            const hasDesktopPanes = Object.prototype.hasOwnProperty.call(settings, "desktopPanes")
                && settings.desktopPanes && typeof settings.desktopPanes === "object";
            const hasSessionViews = Object.prototype.hasOwnProperty.call(settings, "sessionViews")
                && settings.sessionViews && typeof settings.sessionViews === "object";
            const nextSessionViews = hasSessionViews
                ? mergeSessionViews(normalizeStoredSessionViews(settings.sessionViews), state.ui.sessionViews)
                : state.ui.sessionViews;
            const nextDesktopPanes = (hasDesktopPanes || hasRightPaneMode)
                ? normalizeStoredDesktopPanes(
                    hasDesktopPanes ? settings.desktopPanes : null,
                    hasRightPaneMode ? settings.rightPaneMode : null,
                )
                : null;
            const hasCanvasPrefs = Object.prototype.hasOwnProperty.call(settings, "canvasPrefs");
            const hasPins = Object.prototype.hasOwnProperty.call(settings, "pinnedSessionIds");
            const hasCollapsed = Object.prototype.hasOwnProperty.call(settings, "collapsedSessionIds");
            const hasSessionOrder = Object.prototype.hasOwnProperty.call(settings, "sessionOrder");
            // A pending/resolved deep-link intent outranks the profile's
            // persisted activeSessionId — a remote profile poll must not
            // yank selection away from the linked session.
            const navigationIntentLatched = Boolean(
                state.sessions.navigationIntent
                && state.sessions.navigationIntent.status !== "failed",
            );
            const hasActive = Object.prototype.hasOwnProperty.call(settings, "activeSessionId")
                && !navigationIntentLatched;
            const hasLoadedSessions = Object.keys(state.sessions.byId || {}).length > 0;
            const nextLayout = hasLayout
                ? {
                    ...(state.ui.layout || {}),
                    ...normalizeStoredLayoutAdjustments(settings.layoutAdjustments),
                }
                : state.ui.layout;
            const nextPinnedIds = hasPins
                ? (hasLoadedSessions
                    ? prunePinnedIds(normalizeStoredPinnedSessionIds(settings.pinnedSessionIds), state.sessions.byId)
                    : normalizeStoredPinnedSessionIds(settings.pinnedSessionIds))
                : state.sessions.pinnedIds;
            const nextCollapsedIds = hasCollapsed
                ? (hasLoadedSessions
                    ? pruneCollapsedIds(normalizeStoredCollapsedSessionIds(settings.collapsedSessionIds), state.sessions.byId)
                    : normalizeStoredCollapsedSessionIds(settings.collapsedSessionIds))
                : state.sessions.collapsedIds;
            const nextManualOrder = hasSessionOrder
                ? normalizeStoredSessionOrder(settings.sessionOrder)
                : state.sessions.manualOrder;
            const nextActiveSessionId = hasActive
                ? normalizeStoredActiveSessionId(settings.activeSessionId)
                : state.sessions.activeSessionId;
            const nextSessions = {
                ...state.sessions,
                ...(hasOwnerFilter
                    ? {
                        // A stored filter that predates a just-admitted owner
                        // (the first poll racing the deep link, or another
                        // device's save) must not drop that owner again.
                        ownerFilter: keepAdmittedOwner(
                            normalizeSessionOwnerFilter(settings.sessionOwnerFilter),
                            state.sessions.ownerFilterAutoAdmitted,
                        ),
                        ownerFilterExplicit: true,
                    }
                    : {}),
                pinnedIds: nextPinnedIds,
                manualOrder: nextManualOrder,
                collapsedIds: nextCollapsedIds,
                collapsedIdsExplicit: hasCollapsed ? true : state.sessions.collapsedIdsExplicit,
                activeSessionId: nextActiveSessionId,
                flat: (hasPins || hasCollapsed || hasSessionOrder)
                    ? buildSessionTree(Object.values(state.sessions.byId), nextCollapsedIds, state.sessions.orderById, nextPinnedIds, nextManualOrder)
                    : state.sessions.flat,
            };
            const selection = hasLoadedSessions && (hasOwnerFilter || hasPins || hasCollapsed || hasActive)
                ? applyVisibleSessionSelection(state, nextSessions)
                : { sessions: nextSessions, ui: state.ui };
            return {
                ...state,
                sessions: selection.sessions,
                ui: {
                    ...selection.ui,
                    moa: !state.ui.moaDirty && Object.prototype.hasOwnProperty.call(settings, "moa") ? normalizeMoa(settings.moa) : selection.ui.moa,
                    moaLoaded: true,
                    themeId: hasTheme ? settings.themeId.trim() : selection.ui.themeId,
                    touchScale: hasTouchScale ? settings.touchScale : selection.ui.touchScale,
                    sessionDetailCollapsed: hasSessionDetailCollapsed
                        ? settings.sessionDetailCollapsed
                        : selection.ui.sessionDetailCollapsed,
                    agentPickerUsage: hasAgentPickerUsage
                        ? settings.agentPickerUsage
                        : selection.ui.agentPickerUsage,
                    rightPaneMode: hasRightPaneMode ? settings.rightPaneMode : selection.ui.rightPaneMode,
                    ...(nextDesktopPanes
                        ? { canvasOpen: nextDesktopPanes.canvasOpen, diagnosticsOpen: nextDesktopPanes.diagnosticsOpen, canvasZen: nextDesktopPanes.zen === true }
                        : {}),
                    layout: nextLayout,
                    sessionViews: nextSessionViews,
                    // Read once is enough: from here on this tab records.
                    sessionViewsLoaded: true,
                },
                canvas: hasCanvasPrefs
                    ? { ...state.canvas, prefs: mergeCanvasPrefs(state.canvas.prefs, normalizeStoredCanvasPrefs(settings.canvasPrefs), hasLoadedSessions ? state.sessions.byId : null) }
                    : state.canvas,
            };
        }

        case "ui/modal":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    modal: action.modal ?? null,
                },
            };

        case "ui/viewport": {
            const currentWidth = state.ui.layout?.viewportWidth ?? 120;
            const currentHeight = state.ui.layout?.viewportHeight ?? 40;
            const nextWidth = Math.max(40, action.width ?? currentWidth);
            const nextHeight = Math.max(18, action.height ?? currentHeight);
            if (nextWidth === currentWidth && nextHeight === currentHeight) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        viewportWidth: nextWidth,
                        viewportHeight: nextHeight,
                    },
                },
            };
        }

        case "ui/paneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        paneAdjust: Number(action.paneAdjust) || 0,
                    },
                },
            };

        case "ui/sessionPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        sessionPaneAdjust: Number(action.sessionPaneAdjust) || 0,
                    },
                },
            };

        case "ui/portalSessionColumnAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        portalSessionColumnAdjust: Number(action.portalSessionColumnAdjust) || 0,
                    },
                },
            };

        // Where the canvas/diagnostics seam sits when both columns are open.
        // A pixel delta from an even split of the right side, like the other
        // adjusts. Closing a column is a separate action — see
        // CanvasDiagnosticsResizeHandle, which decides that on release.
        case "ui/canvasPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        canvasPaneAdjust: Number(action.canvasPaneAdjust) || 0,
                    },
                },
            };

        // ── Budget screen: tab + the Cluster summary ─────────────────
        case "budget/tab": {
            const tab = ["summary", "agents"].includes(action.tab) ? action.tab : "providers";
            if (state.budget.tab === tab) return state;
            return { ...state, budget: { ...state.budget, tab } };
        }
        case "budget/summary/filter": {
            const prev = state.budget.summary;
            const days = [14, 30, 90].includes(Number(action.days)) ? Number(action.days) : prev.days;
            const providers = Array.isArray(action.providers)
                ? action.providers.map((p) => String(p ?? "").trim()).filter(Boolean)
                : prev.providers;
            const preset = ["all", "shared", "users", "custom"].includes(action.preset) ? action.preset
                : (Array.isArray(action.providers) ? "custom" : prev.preset);
            return { ...state, budget: { ...state.budget, summary: { ...prev, days, providers, preset } } };
        }
        case "budget/summary/loading":
            return { ...state, budget: { ...state.budget, summary: { ...state.budget.summary, loading: true } } };
        case "budget/summary/loaded":
            return {
                ...state,
                budget: {
                    ...state.budget,
                    summary: {
                        ...state.budget.summary,
                        loading: false,
                        error: null,
                        fetchedAt: Number(action.fetchedAt) || Date.now(),
                        data: action.data && typeof action.data === "object" ? action.data : null,
                    },
                },
            };
        case "budget/agents/loading":
            return { ...state, budget: { ...state.budget, agents: { ...state.budget.agents, loading: true } } };
        case "budget/agents/loaded":
            return {
                ...state,
                budget: {
                    ...state.budget,
                    agents: {
                        ...state.budget.agents,
                        loading: false,
                        error: null,
                        fetchedAt: Number(action.fetchedAt) || Date.now(),
                        data: action.data && typeof action.data === "object" ? action.data : null,
                    },
                },
            };
        case "budget/agents/failed":
            return {
                ...state,
                budget: {
                    ...state.budget,
                    agents: { ...state.budget.agents, loading: false, error: String(action.error || "The agent pivot could not be read.") },
                },
            };
        case "budget/summary/failed":
            // Keep the last answer on screen; say the read failed beside it.
            return {
                ...state,
                budget: {
                    ...state.budget,
                    summary: { ...state.budget.summary, loading: false, error: String(action.error || "The summary could not be read.") },
                },
            };

        case "ui/diagnosticsSplitAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        diagnosticsSplitAdjust: Number(action.diagnosticsSplitAdjust) || 0,
                    },
                },
            };

        case "ui/diagnosticsPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        diagnosticsPaneAdjust: Number(action.diagnosticsPaneAdjust) || 0,
                    },
                },
            };

        case "ui/activityPaneAdjust":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    layout: {
                        ...(state.ui.layout || {}),
                        activityPaneAdjust: Number(action.activityPaneAdjust) || 0,
                    },
                },
            };

        case "ui/focus":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    focusRegion: action.focusRegion,
                    // The RAW region the caller asked for, before layout
                    // normalization. A workspace region (sessions/chat) with no
                    // slot in the current layout normalizes to the first
                    // focusable pane — inspector, on a phone — so the normalized
                    // value alone cannot tell "focus the inspector" from
                    // "sessions got rewritten to inspector". The mobile
                    // follow-focus pane switch reads this to avoid opening
                    // diagnostics when the user only asked for the workspace.
                    requestedFocusRegion: action.requestedFocusRegion ?? action.focusRegion,
                },
            };

        case "ui/sequenceExpandedTurns":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sequenceExpandedTurns: Array.isArray(action.turns) ? action.turns : [],
                },
            };

        case "ui/sequenceSelectedTurn":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sequenceSelectedTurn: action.turn == null ? null : Number(action.turn),
                },
            };

        case "sessions/filterQuery":
            {
                const nextSessions = {
                    ...state.sessions,
                    filterQuery: typeof action.query === "string" ? action.query : "",
                    // A filter change is an explicit user action: it releases
                    // the deep-link latch and its transient filter exception.
                    navigationIntent: null,
                    filterExceptionId: null,
                ownerFilterAutoAdmitted: null,
                };
                const selection = applyVisibleSessionSelection(state, nextSessions);
                return {
                    ...state,
                    sessions: selection.sessions,
                    ui: selection.ui,
                };
            }

        case "sessions/ownerFilter":
            {
                const nextSessions = {
                    ...state.sessions,
                    ownerFilterExplicit: true,
                    ownerFilter: normalizeSessionOwnerFilter(action.filter),
                    navigationIntent: null,
                    filterExceptionId: null,
                ownerFilterAutoAdmitted: null,
                };
                const selection = applyVisibleSessionSelection(state, nextSessions);
                return {
                    ...state,
                    sessions: selection.sessions,
                    ui: selection.ui,
                };
            }

        case "sessions/navigationIntent": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const nextSessions = {
                ...state.sessions,
                // A deep link is explicit navigation. Keep the list highlight
                // aligned with the linked chat even if empty-space click had
                // previously deselected the session row.
                listDeselected: false,
                navigationIntent: { sessionId, status: "pending" },
                filterExceptionId: null,
                ownerFilterAutoAdmitted: null,
            };
            const selection = applyVisibleSessionSelection(state, nextSessions);
            return {
                ...state,
                sessions: selection.sessions,
                ui: selection.ui,
            };
        }

        case "sessions/navigationIntentFailed": {
            const intent = state.sessions.navigationIntent;
            const sessionId = String(action.sessionId || "").trim();
            if (!intent || (sessionId && intent.sessionId !== sessionId)) return state;
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    navigationIntent: {
                        sessionId: intent.sessionId,
                        status: "failed",
                        errorKind: action.errorKind === "not_found" ? "not_found" : "network",
                    },
                },
            };
        }

        case "ui/modalSelection": {
            const modal = state.ui.modal;
            if (!modal) return state;
            if (modal.type === "help") {
                // The help overlay has no `items`; the row-count upper bound is
                // clamped by selectHelpModal, so just track the scroll anchor.
                return {
                    ...state,
                    ui: {
                        ...state.ui,
                        modal: { ...modal, selectedIndex: Math.max(0, Number(action.index) || 0) },
                    },
                };
            }
            if (!Array.isArray(modal.items) || modal.items.length === 0) {
                return state;
            }
            const nextIndex = Math.max(0, Math.min(action.index ?? 0, modal.items.length - 1));
            const previewThemeId = modal.type === "themePicker" ? modal.items[nextIndex]?.id : null;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    ...(previewThemeId ? { themeId: previewThemeId } : {}),
                    modal: {
                        ...modal,
                        selectedIndex: nextIndex,
                    },
                },
            };
        }

        case "ui/scroll":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        [action.pane]: Math.max(0, action.offset ?? 0),
                    },
                },
            };

        case "ui/followBottom": {
            if (action.pane !== "inspector" && action.pane !== "activity") {
                return state;
            }
            const nextFollowBottom = Boolean(action.followBottom);
            if (state.ui.followBottom?.[action.pane] === nextFollowBottom) {
                return state;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        [action.pane]: nextFollowBottom,
                    },
                },
            };
        }

        case "ui/nodeMapSelect": {
            // Set, never toggle: a node is always selected while the Node Map
            // is up, and the remembered choice survives leaving the tab.
            if (!action.label) return state;
            return { ...state, ui: { ...state.ui, nodeMapSelectedNode: String(action.label) } };
        }
        case "ui/inspectorTab":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    inspectorTab: action.inspectorTab,
                    fullscreenPane: action.inspectorTab === "files" && state.ui.fullscreenPane === FOCUS_REGIONS.INSPECTOR
                        ? null
                        : state.ui.fullscreenPane,
                    scroll: {
                        ...state.ui.scroll,
                        inspector: 0,
                    },
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        inspector: true,
                    },
                },
                files: action.inspectorTab === "files"
                    ? state.files
                    : {
                        ...state.files,
                        fullscreen: false,
                    },
            };

        case "ui/statsViewMode":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    statsViewMode: ["session", "fleet", "users"].includes(action.statsViewMode)
                        ? action.statsViewMode
                        : "session",
                    scroll: {
                        ...state.ui.scroll,
                        inspector: 0,
                    },
                },
            };

        case "ui/prompt":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    prompt: action.prompt,
                    promptCursor: clampPromptCursor(action.prompt, action.promptCursor, state.ui.promptCursor),
                    promptRows: getPromptInputRows(action.prompt),
                    promptAttachments: normalizePromptAttachments(action.prompt, state.ui.promptAttachments),
                },
            };

        case "ui/promptEdit":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    promptEdit: action.promptEdit ?? null,
                },
            };

        case "ui/promptAttachments":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    promptAttachments: normalizePromptAttachments(
                        state.ui.prompt,
                        action.attachments,
                    ),
                },
            };

        case "sessions/gone": {
            // Terminal eviction: the server answered 404 for this session (or
            // we just deleted it). Drop the row and release the active-session
            // latch so panes unbind and the data loops stop retrying — the
            // sessions/loaded active-session carve-out below would otherwise
            // resurrect the row forever.
            const goneId = action.sessionId;
            if (!goneId) return state;
            const hadRow = Boolean(state.sessions.byId[goneId]);
            const wasActive = state.sessions.activeSessionId === goneId;
            const hadContent = state.history.bySessionId.has(goneId)
                || [state.files, state.canvas, state.orchestration, state.executionHistory, state.outbox, state.sessionStats]
                    .some((slice) => Object.hasOwn(slice?.bySessionId || {}, goneId));
            if (!hadRow && !wasActive && !hadContent) return state;
            const evictedById = { ...state.sessions.byId };
            delete evictedById[goneId];
            // Re-derive: the evicted row may have been the running CHILD that
            // put an ancestor into awaiting_children, and that ancestor is not
            // named in this action. Without it the parent reads "waiting on 1"
            // with nothing left to wait for until the next poll.
            const byId = applyActiveDescendantCounts(evictedById);
            const selectedIds = Array.isArray(state.sessions.selectedIds)
                ? state.sessions.selectedIds.filter((id) => id !== goneId)
                : state.sessions.selectedIds;
            const history = new Map(state.history.bySessionId);
            history.delete(goneId);
            const discard = (slice) => {
                if (!slice?.bySessionId) return slice;
                const bySessionId = { ...slice.bySessionId };
                delete bySessionId[goneId];
                return { ...slice, bySessionId };
            };
            return {
                ...state,
                history: { ...state.history, bySessionId: history },
                files: discard(state.files),
                orchestration: discard(state.orchestration),
                executionHistory: discard(state.executionHistory),
                canvas: discard(state.canvas),
                outbox: discard(state.outbox),
                sessionStats: discard(state.sessionStats),
                sessions: {
                    ...state.sessions,
                    byId,
                    selectedIds,
                    activeSessionId: wasActive ? null : state.sessions.activeSessionId,
                    goneIds: [...new Set([...(state.sessions.goneIds || []), goneId])].slice(-1000),
                },
            };
        }
        case "sessions/loaded": {
            const byId = {};
            let anyChanged = false;
            const nowMs = Date.now();
            // Folders first: this case rebuilds byId from the payload, so a
            // session refresh that carries no groups would otherwise delete
            // every folder until the next group fetch — the "flickers in and
            // out" bug. They are re-seeded from their own slice and can only
            // be removed by sessions/groupsLoaded.
            for (const groupRow of (state.sessions.groupRows || [])) {
                byId[groupRow.sessionId] = state.sessions.byId[groupRow.sessionId] || groupRow;
            }
            for (const session of action.sessions) {
                const previous = state.sessions.byId[session.sessionId];
                byId[session.sessionId] = retainSessionWarnings(previous, mergeDefinedSessionFields(previous, session),
                    state.history.bySessionId.get(session.sessionId)?.events, nowMs);
            }
            if (
                state.sessions.activeSessionId
                && state.sessions.byId[state.sessions.activeSessionId]
                && !state.sessions.byId[state.sessions.activeSessionId]?.isGroup
                && !byId[state.sessions.activeSessionId]
            ) {
                byId[state.sessions.activeSessionId] = {
                    ...state.sessions.byId[state.sessions.activeSessionId],
                };
                anyChanged = true;
            }
            // Descendant counts BEFORE row visual status: awaiting_children is
            // derived from activeChildCount, so stamping it after the debounce
            // ran would leave every parent one poll behind its own children.
            const countedById = applyActiveDescendantCounts(byId);
            const rowStatusById = applyRowVisualStatuses(state.sessions.byId, countedById, nowMs);
            for (const [sessionId, session] of Object.entries(rowStatusById)) {
                if (session !== state.sessions.byId[sessionId]) { anyChanged = true; break; }
            }
            // Check if session set changed (added/removed)
            const prevIds = Object.keys(state.sessions.byId);
            const nextIds = Object.keys(rowStatusById);
            if (prevIds.length !== nextIds.length) anyChanged = true;
            if (!anyChanged) {
                for (const id of nextIds) {
                    if (!state.sessions.byId[id]) { anyChanged = true; break; }
                }
            }
            if (!anyChanged) return state;
            const mergedSessions = Object.values(rowStatusById);
            const hasExistingOrder = Object.keys(state.sessions.orderById || {}).length > 0;
            const initialCollapsedIds = collectDefaultCollapsedSessionIds(mergedSessions);
            const previousCollapsedIdsExplicit = Boolean(state.sessions.collapsedIdsExplicit);
            const {
                orderById,
                nextOrderOrdinal,
            } = hasExistingOrder
                ? assignStableSessionOrder(
                    state.sessions.orderById,
                    state.sessions.nextOrderOrdinal,
                    mergedSessions,
                )
                : assignInitialSessionOrder(mergedSessions, state.sessions.pinnedIds);
            const collapsedIds = previousCollapsedIdsExplicit
                ? cloneCollapsedIds(state.sessions.collapsedIds)
                : initialCollapsedIds;
            // A row that ARRIVES while the app is open starts collapsed, even
            // for a user with explicit preferences — a new sub-tree should not
            // spill open on its own.
            //
            // "Arrives" is only meaningful against a baseline. On the FIRST
            // listing after a page load there is none (byId is empty), so
            // every row looked new and this force-collapsed the whole tree
            // over the profile that had just been restored. The save effect
            // then persisted that, and the next load read its own corruption
            // back as the user's preference — a one-way ratchet, which is why
            // one refresh looked fine and the one after it collapsed
            // everything. With no baseline we cannot tell new from
            // pre-existing, so we add nothing and trust the restored state.
            const hadBaseline = state.sessions.listingSeen === true;
            if (previousCollapsedIdsExplicit && hadBaseline) {
                const previousDefaultCollapsedIds = collectDefaultCollapsedSessionIds(Object.values(state.sessions.byId));
                for (const sessionId of initialCollapsedIds) {
                    if (!previousDefaultCollapsedIds.has(sessionId)) {
                        collapsedIds.add(sessionId);
                    }
                }
            }
            // Drop pins/selection for sessions that no longer exist; only
            // keep pins on top-level rows (groups and ungrouped top-level
            // sessions). Sessions inside containers lose their pins.
            const survivingPins = prunePinnedIds(state.sessions.pinnedIds, rowStatusById);
            const survivingSelected = pruneIdList(state.sessions.selectedIds, rowStatusById);
            const flat = buildSessionTree(mergedSessions, collapsedIds, orderById, survivingPins, state.sessions.manualOrder);
            const nextSessions = {
                ...state.sessions,
                byId: rowStatusById,
                goneIds: (state.sessions.goneIds || []).filter((id) => !action.sessions.some((row) => row.sessionId === id)),
                collapsedIds,
                collapsedIdsExplicit: previousCollapsedIdsExplicit,
                listingSeen: true,
                pinnedIds: survivingPins,
                selectedIds: survivingSelected,
                selectMode: state.sessions.selectMode && survivingSelected.length > 0,
                flat,
                activeSessionId: state.sessions.activeSessionId,
                orderById,
                nextOrderOrdinal,
            };
            const selection = applyVisibleSessionSelection(state, nextSessions);
            return {
                ...state,
                sessions: selection.sessions,
                ui: selection.ui,
            };
        }

        case "sessions/groupsLoaded": {
            // The ONLY writer of folder rows. A successful fetch is the whole
            // truth: folders it omits are gone, folders it names are kept.
            const groups = Array.isArray(action.groups) ? action.groups : [];
            const byId = { ...state.sessions.byId };
            // A folder the fetch omits is gone — UNLESS a loaded session still
            // claims membership in it. Deleting one that is still referenced
            // was visibly destructive: the titled row was replaced by a
            // generic stand-in ("Group"), and because collapse state is keyed
            // by row id, the pruned entry took the group's COLLAPSED state
            // with it, so the whole group sprang open and dumped its members
            // into the list. One transient empty-but-successful listing did
            // all of that. Keep the row we already have; the stand-in stays
            // the last resort for a folder we have never seen.
            //
            // Judge that against the INCOMING catalog when the refresh sends
            // it: this action lands before sessions/loaded, so state still
            // holds the PREVIOUS membership, and a folder whose last member
            // had just moved out looked claimed by its own stale members and
            // survived its deletion forever.
            const claimSource = Array.isArray(action.sessions)
                ? action.sessions
                : Object.values(state.sessions.byId);
            const claimedByLoadedSessions = new Set(
                claimSource
                    .filter((session) => session && !session.isGroup && session.groupId && !session.parentSessionId)
                    .map((session) => `group:${session.groupId}`),
            );
            const keptRows = [];
            for (const key of Object.keys(byId)) {
                if (!byId[key]?.isGroup) continue;
                if (groups.some((row) => row.sessionId === key)) continue;
                if (claimedByLoadedSessions.has(key)) { keptRows.push(byId[key]); continue; }
                delete byId[key];
            }
            for (const row of groups) {
                byId[row.sessionId] = { ...(byId[row.sessionId] || {}), ...row };
            }
            const survivingPins = prunePinnedIds(state.sessions.pinnedIds, byId);
            const { orderById, nextOrderOrdinal } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                Object.values(byId),
            );
            // A folder the state has not seen before starts COLLAPSED, exactly
            // as it does on first load — otherwise a folder that round-trips
            // (deleted by one listing, restored by the next) comes back open
            // and spills its members into the list.
            //
            // "Not seen before" needs something to have been seen. On a fresh
            // page load byId is empty, so every folder qualified and this
            // re-collapsed everything the user had left open, on top of the
            // profile that had just been restored. Same baseline rule as
            // sessions/loaded: with nothing to compare against, add nothing.
            //
            // (An earlier attempt keyed this off collapsedIdsExplicit, which
            // fixed the reload but also stopped a genuinely new folder —
            // created while the app is open — from starting collapsed. The
            // baseline test gets both right.)
            const hadGroupBaseline = state.sessions.groupsListingSeen === true;
            const nextCollapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            for (const row of groups) {
                if (!hadGroupBaseline) continue;
                if (!state.sessions.byId[row.sessionId]) nextCollapsedIds.add(row.sessionId);
            }
            const nextSessions = {
                ...state.sessions,
                // sessions/loaded re-seeds folders from this slice, so a kept
                // row has to live here too or the next session refresh drops it.
                groupRows: [...groups, ...keptRows],
                byId,
                pinnedIds: survivingPins,
                orderById,
                nextOrderOrdinal,
                collapsedIds: nextCollapsedIds,
                groupsListingSeen: true,
                flat: buildSessionTree(Object.values(byId), nextCollapsedIds, orderById, survivingPins, state.sessions.manualOrder),
            };
            const groupSelection = applyVisibleSessionSelection(state, nextSessions);
            return { ...state, sessions: groupSelection.sessions, ui: groupSelection.ui };
        }
        case "sessions/merged": {
            if (!action.session?.sessionId) return state;
            const previousSession = state.sessions.byId[action.session.sessionId];
            const mergedSession = retainSessionWarnings(previousSession, mergeDefinedSessionFields(previousSession, action.session),
                state.history.bySessionId.get(action.session.sessionId)?.events);
            // A single session going running/idle changes its ANCESTORS' counts
            // and therefore their visual status, so both passes run over the
            // whole map rather than the one row. buildSessionTree below is
            // already an O(n) pass over the same map, so this adds no new
            // complexity class.
            const byId = applyRowVisualStatuses(
                state.sessions.byId,
                applyActiveDescendantCounts({
                    ...state.sessions.byId,
                    [action.session.sessionId]: mergedSession,
                }),
                Date.now(),
            );
            let anyRowChanged = false;
            for (const [sessionId, session] of Object.entries(byId)) {
                if (session !== state.sessions.byId[sessionId]) { anyRowChanged = true; break; }
            }
            if (!anyRowChanged) return state;
            const survivingPins = prunePinnedIds(state.sessions.pinnedIds, byId);
            const {
                orderById,
                nextOrderOrdinal,
            } = assignStableSessionOrder(
                state.sessions.orderById,
                state.sessions.nextOrderOrdinal,
                Object.values(byId),
            );
            const nextSessions = {
                ...state.sessions,
                byId,
                pinnedIds: survivingPins,
                flat: buildSessionTree(Object.values(byId), state.sessions.collapsedIds, orderById, survivingPins, state.sessions.manualOrder),
                activeSessionId: state.sessions.activeSessionId,
                orderById,
                nextOrderOrdinal,
            };
            const selection = applyVisibleSessionSelection(state, nextSessions);
            return {
                ...state,
                sessions: selection.sessions,
                ui: selection.ui,
            };
        }

        case "sessions/selected": {
            state = { ...state, sessions: { ...state.sessions, listDeselected: false } };
            // Per-session chat scroll memory: stash the outgoing session's
            // offset and restore the incoming one's. If new chat arrives on
            // re-entry, history/set's activeChatUpdated reset still snaps to
            // latest — "latest chat, or where you left it".
            const previousActiveId = state.sessions.activeSessionId;
            const savedChatScroll = { ...(state.ui.chatScrollBySession || {}) };
            if (previousActiveId && previousActiveId !== action.sessionId) {
                savedChatScroll[previousActiveId] = Number(state.ui.scroll?.chat) || 0;
            }
            // Per-session prompt drafts: a half-written message belongs to the
            // session it was written in. Stash the outgoing draft (text +
            // staged attachments) and restore the incoming one, exactly like
            // the chat-scroll memory above. Exception: while editing a pending
            // outbox message the composer text lives in that outbox item, not
            // in a draft — leave the item alone, drop the edit latch, and give
            // the incoming session its own draft back.
            const switchingSession = previousActiveId !== action.sessionId;
            const savedDrafts = { ...(state.ui.promptDraftBySession || {}) };
            let nextPrompt = state.ui.prompt;
            let nextPromptCursor = state.ui.promptCursor;
            let nextPromptAttachments = state.ui.promptAttachments;
            let nextPromptEdit = state.ui.promptEdit ?? null;
            if (switchingSession) {
                const editingPending = Boolean(state.ui.promptEdit);
                if (!editingPending && previousActiveId) {
                    const outgoing = {
                        prompt: String(state.ui.prompt || ""),
                        attachments: Array.isArray(state.ui.promptAttachments) ? state.ui.promptAttachments : [],
                    };
                    if (outgoing.prompt || outgoing.attachments.length > 0) {
                        savedDrafts[previousActiveId] = outgoing;
                    } else {
                        delete savedDrafts[previousActiveId];
                    }
                }
                const incoming = action.sessionId ? savedDrafts[action.sessionId] : null;
                delete savedDrafts[action.sessionId];
                nextPrompt = incoming?.prompt || "";
                nextPromptCursor = nextPrompt.length;
                nextPromptAttachments = Array.isArray(incoming?.attachments) ? incoming.attachments : [];
                nextPromptEdit = null;
            }
            // Manual navigation to a different session releases the deep-link
            // latch and its transient filter exception.
            const releasesNavigationLatch = Boolean(
                state.sessions.navigationIntent
                && state.sessions.navigationIntent.sessionId !== action.sessionId,
            );
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    activeSessionId: action.sessionId,
                    ...(releasesNavigationLatch
                        ? { navigationIntent: null, filterExceptionId: null, ownerFilterAutoAdmitted: null }
                        : {}),
                },
                ui: {
                    ...state.ui,
                    chatScrollBySession: savedChatScroll,
                    promptDraftBySession: savedDrafts,
                    prompt: nextPrompt,
                    promptCursor: nextPromptCursor,
                    promptRows: getPromptInputRows(nextPrompt),
                    promptAttachments: nextPromptAttachments,
                    promptEdit: nextPromptEdit,
                    // Status notices are per-moment, usually per-session (send
                    // refusals, access hints) — a stale one must not follow the
                    // user to the next session.
                    statusText: previousActiveId !== action.sessionId ? "" : state.ui.statusText,
                    scroll: {
                        ...state.ui.scroll,
                        chat: Number(savedChatScroll[action.sessionId]) || 0,
                        inspector: 0,
                        activity: 0,
                    },
                    followBottom: {
                        ...(state.ui.followBottom || {}),
                        inspector: true,
                        activity: true,
                    },
                },
            };
        }

        case "ui/revealCreatedSession":
            return {
                ...state,
                files: { ...state.files, fullscreen: false, paneOpen: false },
                ui: { ...state.ui, revealedCreatedSessionId: action.sessionId, fullscreenPane: null },
            };

        case "ui/fullscreenPane": {
            const fullscreenPane = normalizeFullscreenPane(action.fullscreenPane);
            return {
                ...state,
                files: fullscreenPane
                    ? {
                        ...state.files,
                        fullscreen: false,
                    }
                    : state.files,
                ui: {
                    ...state.ui,
                    fullscreenPane,
                    focusRegion: fullscreenPane || state.ui.focusRegion,
                },
            };
        }

        case "sessions/collapse": {
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            collapsedIds.add(action.sessionId);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    collapsedIds,
                    collapsedIdsExplicit: true,
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById, state.sessions.pinnedIds, state.sessions.manualOrder),
                },
            };
        }

        case "sessions/expand": {
            const collapsedIds = cloneCollapsedIds(state.sessions.collapsedIds);
            collapsedIds.delete(action.sessionId);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    collapsedIds,
                    collapsedIdsExplicit: true,
                    flat: buildSessionTree(Object.values(state.sessions.byId), collapsedIds, state.sessions.orderById, state.sessions.pinnedIds, state.sessions.manualOrder),
                },
            };
        }

        case "sessions/pinToggle": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const session = state.sessions.byId[sessionId];
            // Pinning is a TOP-LEVEL-only concept. Groups and ungrouped
            // top-level sessions can be pinned; contained sessions cannot.
            if (!isPinnableSession(session)) return state;
            const current = clonePinnedIds(state.sessions.pinnedIds);
            const existingIndex = current.indexOf(sessionId);
            const nextPinned = existingIndex >= 0
                ? current.filter((id) => id !== sessionId)
                : [...current, sessionId];
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    pinnedIds: nextPinned,
                    flat: buildSessionTree(Object.values(state.sessions.byId), state.sessions.collapsedIds, state.sessions.orderById, nextPinned, state.sessions.manualOrder),
                },
            };
        }

        // Drop `sessionId` immediately before `beforeSessionId` in the user's
        // explicit order (beforeSessionId null ⇒ last among its siblings).
        //
        // The stored list spans every level; ordering only ever compares
        // siblings, so writing a global list is safe and keeps one array to
        // persist. The reducer is deliberately permissive about ids it does
        // not recognise — the desktop is the only writer, but a phone or TUI
        // may hold a narrower slice of the fleet, and dropping unknown ids
        // here would let the smaller surface erase the larger one's placements.
        case "sessions/reorder": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const session = state.sessions.byId[sessionId];
            // The tree ignores placements for immovable rows; refusing here
            // too keeps the stored list free of entries that can never apply.
            if (!isManuallyOrderableSession(session)) return state;

            const beforeId = action.beforeSessionId == null
                ? null
                : String(action.beforeSessionId).trim() || null;
            if (beforeId === sessionId) return state;

            // Seed from the CURRENT rendered order so a first drag preserves
            // what the user is looking at. Without this, moving one row would
            // leave every other row unplaced and re-sorted underneath it.
            const seed = Array.isArray(state.sessions.manualOrder) && state.sessions.manualOrder.length > 0
                ? state.sessions.manualOrder
                : (state.sessions.flat || [])
                    .map((entry) => entry.sessionId)
                    .filter((id) => isManuallyOrderableSession(state.sessions.byId[id]));

            const without = seed.filter((id) => id !== sessionId);
            const insertAt = beforeId ? without.indexOf(beforeId) : -1;
            const nextManualOrder = insertAt >= 0
                ? [...without.slice(0, insertAt), sessionId, ...without.slice(insertAt)]
                : [...without, sessionId];

            const unchanged = nextManualOrder.length === (state.sessions.manualOrder || []).length
                && nextManualOrder.every((id, index) => id === state.sessions.manualOrder[index]);
            if (unchanged) return state;

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    manualOrder: nextManualOrder,
                    flat: buildSessionTree(
                        Object.values(state.sessions.byId),
                        state.sessions.collapsedIds,
                        state.sessions.orderById,
                        state.sessions.pinnedIds,
                        nextManualOrder,
                    ),
                },
            };
        }

        case "sessions/selectMode": {
            const enabled = Boolean(action.enabled);
            if (enabled === Boolean(state.sessions.selectMode)
                && (enabled || state.sessions.selectedIds.length === 0)) {
                return state;
            }
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectMode: enabled,
                    selectedIds: enabled ? state.sessions.selectedIds : [],
                },
            };
        }

        case "sessions/selectToggle": {
            const sessionId = String(action.sessionId || "").trim();
            const session = sessionId ? state.sessions.byId[sessionId] : null;
            if (!session) return state;
            // System sessions (PilotSwarm, Sweeper, Resource Manager, etc.)
            // and synthetic group rows use dedicated action paths.
            if (session.isSystem || session.isGroup) return state;
            const current = cloneSelectedIds(state.sessions.selectedIds);
            const existingIndex = current.indexOf(sessionId);
            const nextSelected = existingIndex >= 0
                ? current.filter((id) => id !== sessionId)
                : [...current, sessionId];
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: nextSelected,
                    selectMode: nextSelected.length > 0 ? true : state.sessions.selectMode,
                },
            };
        }

        case "sessions/selectSet": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            // System sessions and group rows are not selectable for bulk operations.
            const next = pruneIdList(ids, state.sessions.byId)
                .filter((id) => !state.sessions.byId[id]?.isSystem && !state.sessions.byId[id]?.isGroup);
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: next,
                    selectMode: next.length > 0 ? true : state.sessions.selectMode,
                },
            };
        }

        // Re-arm the list highlight WITHOUT re-running session selection. A
        // plain click on the still-active row after an empty-space deselect
        // cannot go through loadSession (it short-circuits on the active id),
        // so without this the row could never be selected again.
        case "sessions/listReselect": {
            if (!state.sessions.listDeselected) return state;
            return { ...state, sessions: { ...state.sessions, listDeselected: false } };
        }

        case "sessions/listDeselect": {
            // Purely a list affordance: activeSessionId is untouched so the
            // chat, inspector and activity panes carry on unchanged.
            return {
                ...state,
                sessions: { ...state.sessions, listDeselected: true, selectedIds: [], selectMode: false },
            };
        }
        case "sessions/selectClear": {
            if (state.sessions.selectedIds.length === 0 && !state.sessions.selectMode) return state;
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    selectedIds: [],
                    selectMode: false,
                },
            };
        }

        case "history/set": {
            const previousHistory = state.history.bySessionId.get(action.sessionId) || null;
            const previousChat = previousHistory?.chat || [];
            const loadedEventLimit = Math.max(
                DEFAULT_HISTORY_EVENT_LIMIT,
                Number(action.history?.loadedEventLimit ?? previousHistory?.loadedEventLimit ?? DEFAULT_HISTORY_EVENT_LIMIT) || DEFAULT_HISTORY_EVENT_LIMIT,
            );
            const nextChat = clampHistoryItems(dedupeChatMessages(action.history?.chat || []), loadedEventLimit);
            const previousLastChatId = previousChat[previousChat.length - 1]?.id || null;
            const nextLastChatId = nextChat[nextChat.length - 1]?.id || null;
            const activeChatUpdated = action.sessionId === state.sessions.activeSessionId
                && nextLastChatId !== previousLastChatId;
            const nextHistory = cloneHistoryMap(state.history.bySessionId);
            nextHistory.set(action.sessionId, {
                ...(action.history || {}),
                chat: nextChat,
                activity: clampHistoryItems(action.history?.activity || [], loadedEventLimit),
                events: clampHistoryItems(action.history?.events || [], loadedEventLimit),
                loadedEventLimit,
            });
            return {
                ...state,
                history: {
                    ...state.history,
                    bySessionId: nextHistory,
                },
                ui: activeChatUpdated
                    ? {
                        ...state.ui,
                        scroll: {
                            ...state.ui.scroll,
                            chat: 0,
                        },
                    }
                    : state.ui,
            };
        }

        case "history/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const nextHistory = cloneHistoryMap(state.history.bySessionId);
            for (const id of ids) nextHistory.delete(id);
            const nextOutbox = cloneOutboxBySessionId(state.outbox?.bySessionId);
            for (const id of ids) delete nextOutbox[id];
            const nextChatScroll = { ...(state.ui.chatScrollBySession || {}) };
            for (const id of ids) delete nextChatScroll[id];
            const nextDrafts = { ...(state.ui.promptDraftBySession || {}) };
            for (const id of ids) delete nextDrafts[id];
            return {
                ...state,
                history: {
                    ...state.history,
                    bySessionId: nextHistory,
                },
                outbox: {
                    ...state.outbox,
                    bySessionId: nextOutbox,
                },
                ui: {
                    ...state.ui,
                    chatScrollBySession: nextChatScroll,
                    promptDraftBySession: nextDrafts,
                },
            };
        }

        case "outbox/setSessionItems": {
            const sessionId = action.sessionId;
            if (!sessionId) return state;
            const items = Array.isArray(action.items) ? action.items.filter(Boolean) : [];
            const nextOutbox = cloneOutboxBySessionId(state.outbox?.bySessionId);
            if (items.length === 0) {
                delete nextOutbox[sessionId];
            } else {
                nextOutbox[sessionId] = items;
            }
            return {
                ...state,
                outbox: {
                    ...state.outbox,
                    bySessionId: nextOutbox,
                },
            };
        }

        case "orchestration/statsLoading": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
                error: null,
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "orchestration/statsLoaded": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                loading: false,
                error: null,
                fetchedAt: action.fetchedAt || Date.now(),
                stats: action.stats || null,
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "orchestration/statsError": {
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: false,
                error: action.error || "Failed to load orchestration stats",
                fetchedAt: action.fetchedAt || Date.now(),
            };
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "orchestration/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = cloneOrchestrationBySessionId(state.orchestration.bySessionId);
            for (const id of ids) delete bySessionId[id];
            return {
                ...state,
                orchestration: {
                    ...state.orchestration,
                    bySessionId,
                },
            };
        }

        case "executionHistory/loading": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
                error: null,
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/loaded": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            const rawEvents = action.events || [];
            const MAX_EXECUTION_HISTORY_EVENTS = 1000;
            const clampedEvents = rawEvents.length > MAX_EXECUTION_HISTORY_EVENTS
                ? rawEvents.slice(-MAX_EXECUTION_HISTORY_EVENTS)
                : rawEvents;
            bySessionId[action.sessionId] = {
                loading: false,
                error: null,
                fetchedAt: action.fetchedAt || Date.now(),
                events: clampedEvents,
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/evict": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            for (const id of ids) delete bySessionId[id];
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/error": {
            const bySessionId = { ...(state.executionHistory?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: false,
                error: action.error || "Failed to load execution history",
                fetchedAt: action.fetchedAt || Date.now(),
            };
            return {
                ...state,
                executionHistory: { ...state.executionHistory, bySessionId },
            };
        }

        case "executionHistory/format": {
            return {
                ...state,
                executionHistory: {
                    ...state.executionHistory,
                    format: action.format || "pretty",
                },
            };
        }

        // ── Session Stats ────────────────────────────────────

        case "sessionStats/loading": {
            const bySessionId = { ...(state.sessionStats?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                ...(bySessionId[action.sessionId] || {}),
                loading: true,
            };
            return {
                ...state,
                sessionStats: { ...state.sessionStats, bySessionId },
            };
        }

        case "sessionStats/loaded": {
            const bySessionId = { ...(state.sessionStats?.bySessionId || {}) };
            bySessionId[action.sessionId] = {
                loading: false,
                fetchedAt: Date.now(),
                summary: action.summary || null,
                tokensByModel: Array.isArray(action.tokensByModel) ? action.tokensByModel : [],
                treeStats: action.treeStats || null,
                skillUsage: action.skillUsage || null,
                treeSkillUsage: action.treeSkillUsage || null,
                factsStats: action.factsStats || null,
                treeFactsStats: action.treeFactsStats || null,
            };
            return {
                ...state,
                sessionStats: { ...state.sessionStats, bySessionId },
            };
        }

        case "fleetStats/loading": {
            return {
                ...state,
                fleetStats: {
                    ...state.fleetStats,
                    loading: true,
                },
            };
        }

        case "fleetStats/loaded": {
            return {
                ...state,
                fleetStats: {
                    loading: false,
                    data: action.data || null,
                    userStats: action.userStats || null,
                    skillUsage: action.skillUsage || null,
                    retrievalUsage: action.retrievalUsage || null,
                    sharedFactsStats: action.sharedFactsStats || null,
                    factsTombstoneStats: action.factsTombstoneStats || null,
                    fetchedAt: Date.now(),
                },
            };
        }

        case "admin/visibility": {
            const visible = Boolean(action.visible);
            if (state.admin.visible === visible && !(visible && state.ui.budgetOpen)) return state;
            return {
                ...state,
                // The admin console and the Providers & Budgets surface take
                // the SAME slot — the workspace under the header. Opening the
                // console therefore has to put the budget away, or the console
                // button reads active while the budget is still what is on
                // screen and the click looks dead. `ui/budgetOpen` closes the
                // console; this is the other direction.
                ui: visible && state.ui.budgetOpen ? { ...state.ui, budgetOpen: false } : state.ui,
                admin: {
                    ...state.admin,
                    visible,
                    // Closing the console resets any in-progress edit so the
                    // next open starts on the read-only view, not on a stale
                    // draft.
                    ghcpKey: visible
                        ? state.admin.ghcpKey
                        : { editing: false, draft: "", saving: false, error: null, lastSavedAt: state.admin.ghcpKey.lastSavedAt },
                    modelProviders: visible
                        ? state.admin.modelProviders
                        : {
                            ...state.admin.modelProviders,
                            create: {
                                ...state.admin.modelProviders.create,
                                editing: false,
                                draft: "",
                                cursorIndex: 0,
                                saving: false,
                                error: null,
                            },
                        },
                },
            };
        }
        case "admin/profile/loading": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: true,
                    loadError: null,
                },
            };
        }
        case "admin/profile/loaded": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: false,
                    loadError: null,
                    profile: action.profile || null,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        // A successful load doesn't clobber an in-progress
                        // edit; the user may be in the middle of typing.
                        error: state.admin.ghcpKey.editing ? state.admin.ghcpKey.error : null,
                    },
                },
            };
        }
        case "admin/profile/loadFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    loading: false,
                    loadError: action.error ? String(action.error) : "Failed to load profile",
                },
            };
        }
        case "admin/ghcpKey/beginEdit": {
            const draft = typeof action.draft === "string" ? action.draft : "";
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        editing: true,
                        draft,
                        cursorIndex: draft.length,
                        saving: false,
                        error: null,
                        lastSavedAt: state.admin.ghcpKey.lastSavedAt,
                        storeAsSystem: Boolean(state.admin.ghcpKey.storeAsSystem),
                    },
                },
            };
        }
        case "admin/ghcpKey/setDraft": {
            if (!state.admin.ghcpKey.editing) return state;
            const draft = typeof action.draft === "string" ? action.draft : "";
            const cursorRaw = Number.isFinite(action.cursorIndex) ? Number(action.cursorIndex) : draft.length;
            const cursorIndex = Math.max(0, Math.min(cursorRaw, draft.length));
            if (draft === state.admin.ghcpKey.draft && cursorIndex === state.admin.ghcpKey.cursorIndex) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        draft,
                        cursorIndex,
                        error: null,
                    },
                },
            };
        }
        case "admin/ghcpKey/cancelEdit": {
            if (!state.admin.ghcpKey.editing && !state.admin.ghcpKey.draft) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        editing: false,
                        draft: "",
                        cursorIndex: 0,
                        saving: false,
                        error: null,
                        lastSavedAt: state.admin.ghcpKey.lastSavedAt,
                        storeAsSystem: Boolean(state.admin.ghcpKey.storeAsSystem),
                    },
                },
            };
        }
        case "admin/ghcpKey/saving": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        saving: true,
                        error: null,
                    },
                },
            };
        }
        case "admin/ghcpKey/saveFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        saving: false,
                        error: action.error ? String(action.error) : "Failed to save key",
                    },
                },
            };
        }
        case "admin/ghcpKey/saved": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    profile: action.profile || state.admin.profile,
                    ghcpKey: {
                        editing: false,
                        draft: "",
                        cursorIndex: 0,
                        saving: false,
                        error: null,
                        lastSavedAt: Date.now(),
                        storeAsSystem: Boolean(state.admin.ghcpKey.storeAsSystem),
                    },
                },
            };
        }
        case "admin/ghcpKey/setSystemTarget": {
            const storeAsSystem = Boolean(action.value);
            if (Boolean(state.admin.ghcpKey.storeAsSystem) === storeAsSystem) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        ...state.admin.ghcpKey,
                        storeAsSystem,
                        error: null,
                    },
                },
            };
        }
        case "admin/systemGhcpKey/loading": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    systemGhcpKey: {
                        ...state.admin.systemGhcpKey,
                        loading: true,
                        error: null,
                    },
                },
            };
        }
        case "admin/systemGhcpKey/loaded": {
            const status = action.status || {};
            return {
                ...state,
                admin: {
                    ...state.admin,
                    systemGhcpKey: {
                        supported: true,
                        loading: false,
                        configured: Boolean(status.configured),
                        changedBy: status.changedBy || null,
                        changedAt: status.changedAt || null,
                        error: null,
                    },
                },
            };
        }
        case "admin/systemGhcpKey/loadFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    systemGhcpKey: {
                        ...state.admin.systemGhcpKey,
                        loading: false,
                        error: action.error ? String(action.error) : "Failed to load System key status",
                    },
                },
            };
        }
        case "admin/modelProviders/loading": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        loading: true,
                        error: null,
                    },
                },
            };
        }
        case "admin/modelProviders/loaded": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        loading: false,
                        error: null,
                        providers: Array.isArray(action.providers) ? action.providers : [],
                        models: Array.isArray(action.models) ? action.models : [],
                        defaults: action.defaults || null,
                        fetchedAt: Date.now(),
                    },
                },
            };
        }
        case "admin/modelProviders/loadFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        loading: false,
                        error: action.error ? String(action.error) : "Failed to load model providers",
                    },
                },
            };
        }
        case "admin/modelProviders/mutationPending": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        mutation: { pending: action.pending || "change", error: null },
                    },
                },
            };
        }
        case "admin/modelProviders/mutationDone": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        mutation: { pending: null, error: null },
                    },
                },
            };
        }
        case "admin/modelProviders/mutationFailed": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        mutation: {
                            pending: null,
                            error: action.error ? String(action.error) : "The provider change failed",
                        },
                    },
                },
            };
        }
        /**
         * Put the banner down.
         *
         * A failed mutation writes mutation.error, which the Model Providers
         * pane renders as a red band. Nothing cleared it except the NEXT
         * mutation, so cancelling a failed sheet left the band sitting there
         * over an unchanged list, and it survived until something else
         * succeeded. The sheet that raised it owns it; when that sheet goes,
         * so does this.
         */
        case "admin/modelProviders/mutationDismissed": {
            if (!state.admin?.modelProviders?.mutation?.error) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        mutation: { ...state.admin.modelProviders.mutation, error: null },
                    },
                },
            };
        }
        case "admin/modelProviders/select": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        selection: {
                            focus: action.focus === "agents" ? "agents" : "providers",
                            providerName: action.providerName ?? state.admin.modelProviders.selection?.providerName ?? null,
                            agentId: action.agentId ?? state.admin.modelProviders.selection?.agentId ?? null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/page": {
            const page = action.page === "shared" ? "shared" : "mine";
            if (page === state.admin.modelProviders.page) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        page,
                        selection: {
                            ...state.admin.modelProviders.selection,
                            focus: "providers",
                            providerName: null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createBegin": {
            const draft = String(action.name || "");
            const update = action.mode === "update";
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            editing: true,
                            mode: update ? "update" : "create",
                            stage: update || action.stage === "credential" ? "credential" : "name",
                            name: update ? draft : "",
                            typeId: String(action.typeId || ""),
                            shared: action.shared === true,
                            draft: update ? "" : draft,
                            cursorIndex: update ? 0 : draft.length,
                            saving: false,
                            error: null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createDraft": {
            const draft = String(action.draft || "").replace(/\r?\n/gu, "");
            const cursorIndex = Math.max(0, Math.min(Number(action.cursorIndex) || 0, draft.length));
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: { ...state.admin.modelProviders.create, draft, cursorIndex, error: null },
                    },
                },
            };
        }
        case "admin/modelProviders/createType": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            ...state.admin.modelProviders.create,
                            typeId: String(action.typeId || ""),
                            error: null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createCredential": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            ...state.admin.modelProviders.create,
                            stage: "credential",
                            name: String(action.name || ""),
                            draft: "",
                            cursorIndex: 0,
                            error: null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createSaving": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            ...state.admin.modelProviders.create,
                            draft: "",
                            cursorIndex: 0,
                            saving: true,
                            error: null,
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createFailed": {
            const current = state.admin.modelProviders.create;
            const credentialStage = current.stage === "credential";
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            ...current,
                            draft: credentialStage ? "" : current.draft,
                            cursorIndex: credentialStage ? 0 : current.cursorIndex,
                            saving: false,
                            error: action.error ? String(action.error) : "The provider could not be created",
                        },
                    },
                },
            };
        }
        case "admin/modelProviders/createEnd": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    modelProviders: {
                        ...state.admin.modelProviders,
                        create: {
                            editing: false,
                            stage: "name",
                            name: "",
                            typeId: "",
                            shared: false,
                            draft: "",
                            cursorIndex: 0,
                            saving: false,
                            error: null,
                        },
                    },
                },
            };
        }
        case "admin/section": {
            const section = ["packages", "workers", "ghcp"].includes(action.section) ? action.section : "ghcp";
            return { ...state, admin: { ...state.admin, section } };
        }
        case "admin/workers/attempt": {
            const workers = state.admin.workers || {};
            return { ...state, admin: { ...state.admin, workers: { ...workers, attempts: (workers.attempts || 0) + 1, lastAttemptAt: Date.now(), lastSkip: action.skip || null } } };
        }
        case "admin/workers/loading": {
            return { ...state, admin: { ...state.admin, workers: { ...state.admin.workers, loading: true, error: null } } };
        }
        case "admin/workers/loaded": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    workers: {
                        loading: false,
                        error: null,
                        list: Array.isArray(action.list) ? action.list : [],
                        fetchedAt: Date.now(),
                    },
                },
            };
        }
        case "admin/workers/loadFailed": {
            return { ...state, admin: { ...state.admin, workers: { ...state.admin.workers, loading: false, error: action.error || "Failed to load workers" } } };
        }
        case "admin/packages/loading": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, loading: true, error: null } } };
        }
        case "admin/packages/loaded": {
            const previous = state.admin.packages;
            const list = Array.isArray(action.list) ? action.list : [];
            // Keep the selection when the package still exists; otherwise clear
            // the dependent detail/workspace state with it.
            const selector = previous.selectedSelector;
            const stillThere = previous.selectedName && list.some((p) => p.name === previous.selectedName
                && (!selector?.scope || p.scope === selector.scope)
                && (!selector?.owner || (p.owner?.provider === selector.owner.provider && p.owner?.subject === selector.owner.subject)));
            return {
                ...state,
                admin: {
                    ...state.admin,
                    packages: {
                        ...previous,
                        loading: false,
                        error: null,
                        list,
                        workerState: Array.isArray(action.workerState) ? action.workerState : [],
                        fetchedAt: Date.now(),
                        selectedName: stillThere ? previous.selectedName : null,
                        selectedSelector: stillThere ? (previous.selectedSelector ?? null) : null,
                        ...(stillThere ? {} : { selectionSeq: (previous.selectionSeq ?? 0) + 1, detail: null, changelog: null,
                            workspace: { ...previous.workspace, tree: null, selectedPath: null, file: null } }),
                    },
                },
            };
        }
        case "admin/packages/loadFailed": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, loading: false, error: action.error || "Failed to load agent packages" } } };
        }
        case "admin/packages/select": {
            return {
                ...state,
                admin: {
                    ...state.admin,
                    section: "packages",
                    packages: {
                        ...state.admin.packages,
                        selectedName: action.name || null,
                        // WHICH copy of the name: {scope, owner} from the row
                        // the user clicked. One name can be two packages
                        // (scope shadowing) — without this every read and
                        // action fell back to "own copy first" and could
                        // target the row the user was NOT looking at.
                        selectedSelector: action.selector || null,
                        // Monotonic selection token. The stale-response guards
                        // below compare it, because comparing the NAME alone
                        // cannot tell two copies of a shadowed name apart — a
                        // slow response for the user copy could land on top of
                        // the shared copy the user just clicked.
                        selectionSeq: (state.admin.packages.selectionSeq ?? 0) + 1,
                        detail: null,
                        detailLoading: Boolean(action.name),
                        detailError: null,
                        // Cleared on every selection: showing the previous
                        // package's history under a new package is worse than
                        // showing none.
                        changelog: null,
                        action: { pending: null, error: null },
                        workspace: {
                            tree: null, treeLoading: Boolean(action.name), treeError: null,
                            expandedDirs: [], selectedPath: null,
                            file: null, fileLoading: false, fileError: null,
                        },
                    },
                },
            };
        }
        case "admin/packages/detail/loaded": {
            if (packageResponseIsStale(state.admin.packages, action)) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, detail: action.detail, detailLoading: false, detailError: null } } };
        }
        case "admin/packages/detail/loadFailed": {
            if (packageResponseIsStale(state.admin.packages, action)) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, detail: null, detailLoading: false, detailError: action.error || "Failed to load package" } } };
        }
        case "admin/packages/changelog/loaded": {
            // Stale-response guard, same as the tree: a slow changelog for a
            // previously-selected package must not surface under the current one.
            if (packageResponseIsStale(state.admin.packages, action)) return state;
            return {
                ...state,
                admin: {
                    ...state.admin,
                    packages: {
                        ...state.admin.packages,
                        changelog: action.content || null,
                    },
                },
            };
        }
        case "admin/packages/tree/loaded": {
            if (packageResponseIsStale(state.admin.packages, action)) return state;
            const topDirs = Array.isArray(action.tree?.dirs)
                ? action.tree.dirs.filter((dir) => !dir.includes("/"))
                : [];
            return {
                ...state,
                admin: {
                    ...state.admin,
                    packages: {
                        ...state.admin.packages,
                        workspace: {
                            ...state.admin.packages.workspace,
                            tree: action.tree,
                            treeLoading: false,
                            treeError: null,
                            // Top-level folders start expanded; deeper levels open on click.
                            expandedDirs: topDirs,
                        },
                    },
                },
            };
        }
        case "admin/packages/tree/loadFailed": {
            if (packageResponseIsStale(state.admin.packages, action)) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, workspace: { ...state.admin.packages.workspace, treeLoading: false, treeError: action.error || "Failed to load package files" } } } };
        }
        case "admin/packages/toggleDir": {
            const workspace = state.admin.packages.workspace;
            const expanded = new Set(workspace.expandedDirs);
            if (expanded.has(action.dir)) expanded.delete(action.dir);
            else expanded.add(action.dir);
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, workspace: { ...workspace, expandedDirs: [...expanded] } } } };
        }
        case "admin/packages/file/loading": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, workspace: { ...state.admin.packages.workspace, selectedPath: action.path, file: null, fileLoading: true, fileError: null } } } };
        }
        case "admin/packages/file/loaded": {
            // Path AND selection token: two copies of a shadowed name have the
            // SAME file paths (both ship plugin.json), so a slow preview for
            // the previously-selected copy would otherwise land under the
            // current one. The seq check tells the two copies apart.
            if (state.admin.packages.workspace.selectedPath !== action.file?.path) return state;
            if (typeof action.seq === "number" && (state.admin.packages.selectionSeq ?? 0) !== action.seq) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, workspace: { ...state.admin.packages.workspace, file: action.file, fileLoading: false, fileError: null } } } };
        }
        case "admin/packages/file/loadFailed": {
            if (state.admin.packages.workspace.selectedPath !== action.path) return state;
            if (typeof action.seq === "number" && (state.admin.packages.selectionSeq ?? 0) !== action.seq) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, workspace: { ...state.admin.packages.workspace, fileLoading: false, fileError: action.error || "Failed to load file" } } } };
        }
        case "admin/packages/action/pending": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, action: { pending: action.action, error: null } } } };
        }
        case "admin/packages/action/done": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, action: { pending: null, error: null } } } };
        }
        case "admin/packages/action/failed": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, action: { pending: null, error: action.error || "Action failed" } } } };
        }
        case "admin/packages/addDialog/open": {
            // Update mode reuses this dialog wholesale — the work is identical
            // (point at a repo folder, import it here, publish) and only the
            // destination is already decided.
            const seeded = {
                ...createInitialState().admin.packages.addDialog,
                open: true,
                updateName: action.updateName || null,
                scope: action.scope === "shared" ? "shared" : "user",
            };
            return { ...state, admin: { ...state.admin, section: "packages", packages: { ...state.admin.packages, addDialog: seeded } } };
        }
        case "admin/packages/addDialog/close": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, addDialog: { ...createInitialState().admin.packages.addDialog, open: false } } } };
        }
        case "admin/packages/addDialog/setField": {
            const dialog = state.admin.packages.addDialog;
            if (!(action.field in dialog)) return state;
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, addDialog: { ...dialog, [action.field]: action.value, error: null } } } };
        }
        case "admin/packages/addDialog/submitting": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, addDialog: { ...state.admin.packages.addDialog, submitting: true, progress: null, error: null } } } };
        }
        case "admin/packages/addDialog/progress": {
            // Client-side import is a multi-request walk (tree, then blobs) —
            // the dialog narrates it so a slow repo never looks hung.
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, addDialog: { ...state.admin.packages.addDialog, progress: action.message || null } } } };
        }
        case "admin/packages/addDialog/failed": {
            return { ...state, admin: { ...state.admin, packages: { ...state.admin.packages, addDialog: { ...state.admin.packages.addDialog, submitting: false, progress: null, error: action.error || "Failed to import package" } } } };
        }
        case "admin/systemGhcpKey/saved": {
            const status = action.status || {};
            return {
                ...state,
                admin: {
                    ...state.admin,
                    ghcpKey: {
                        editing: false,
                        draft: "",
                        cursorIndex: 0,
                        saving: false,
                        error: null,
                        lastSavedAt: Date.now(),
                        storeAsSystem: Boolean(state.admin.ghcpKey.storeAsSystem),
                    },
                    systemGhcpKey: {
                        supported: true,
                        loading: false,
                        configured: Boolean(status.configured),
                        changedBy: status.changedBy || null,
                        changedAt: status.changedAt || null,
                        error: null,
                    },
                },
            };
        }

        case "files/evictPreviews": {
            const ids = Array.isArray(action.sessionIds) ? action.sessionIds : [];
            if (ids.length === 0) return state;
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            for (const id of ids) {
                if (bySessionId[id]) {
                    // Keep entries list (lightweight), drop heavy preview content
                    bySessionId[id] = {
                        ...bySessionId[id],
                        previews: {},
                    };
                }
            }
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/sessionLoading": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                loading: true,
                error: null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/sessionLoaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                previews: {},
                downloads: {},
            };
            const entries = normalizeArtifactEntries(action.entries);
            // Stamped by the caller, never Date.now() here — reducers stay pure.
            const fetchedAt = Number(action.fetchedAt) || 0;
            const hasFilename = (filename) => entries.some((entry) => entry.filename === filename);
            const selectedFilename = current.selectedFilename && hasFilename(current.selectedFilename)
                ? current.selectedFilename
                : (action.selectedFilename && hasFilename(action.selectedFilename)
                    ? action.selectedFilename
                    : (entries[0]?.filename || null));
            bySessionId[action.sessionId] = {
                ...current,
                entries,
                selectedFilename,
                loading: false,
                loaded: true,
                // Stored, not just computed — without this the TTL guard read
                // undefined, treated every list as ancient, and refetched on
                // every poll cycle. That was the ~3s flicker.
                fetchedAt,
                error: null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/sessionError": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                loading: false,
                loaded: true,
                error: action.error || "Failed to load files",
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/select": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            bySessionId[action.sessionId] = {
                ...current,
                selectedFilename: action.filename || null,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                    selectedArtifactId: action.sessionId && action.filename
                        ? `${action.sessionId}/${action.filename}`
                        : state.files.selectedArtifactId,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };
        }

        case "files/toggleMark": {
            const id = String(action.artifactId || "");
            if (!id) return state;
            const marked = new Set(state.files.markedIds || []);
            if (marked.has(id)) marked.delete(id);
            else marked.add(id);
            return { ...state, files: { ...state.files, markedIds: [...marked] } };
        }

        case "files/setMarks":
            return {
                ...state,
                files: {
                    ...state.files,
                    markedIds: Array.isArray(action.artifactIds) ? [...new Set(action.artifactIds.map(String))] : [],
                },
            };

        case "files/previewOrigin":
            return {
                ...state,
                files: {
                    ...state.files,
                    previewOrigin: action.origin || null,
                    restoreArtifactId: action.origin === "chat"
                        ? (action.restoreArtifactId ?? state.files.restoreArtifactId ?? null)
                        : null,
                },
            };

        // The artifact takeover pane. `restoresToHidden` is captured ONCE, on
        // the opening transition — reopening while already open must not
        // overwrite it with "the column is visible", which is trivially true
        // whenever the pane itself is showing and would strand a user who had
        // collapsed the column with an inspector they never asked for.
        case "files/pane":
            return {
                ...state,
                files: {
                    ...state.files,
                    paneOpen: Boolean(action.open),
                    paneRestoresToHidden: action.open
                        ? (state.files.paneOpen
                            ? state.files.paneRestoresToHidden
                            : Boolean(action.restoresToHidden))
                        : false,
                },
            };

        // ── Canvas ──────────────────────────────────────────────────────
        // The right column's mode plus the per-session attention state that
        // decides flip-vs-badge. Viewed-marking deliberately does NOT live in
        // these mode transitions: only the rendering surface knows what is
        // actually on screen, so `canvas/viewed` is dispatched by the canvas
        // pane when a revision really displays. Inferring "viewed" from mode
        // changes marked revs seen on a phone whose layout never showed the
        // pane, and left session-switches-while-in-canvas-mode unviewed.
        //   - entering canvas mode is always a user gesture → clears opt-out
        //   - a MANUAL switch away records the opt-out (future draws badge)
        //   - `canvas/flip` is the agent-driven variant: same mode change,
        //     plus a flipSeq tick that hosts with their own pane state (the
        //     phone's tab strip) listen to
        case "ui/rightPaneMode": {
            const mode = action.mode === "canvas" ? "canvas" : "panes";
            const sessionId = action.sessionId || state.sessions.activeSessionId || null;
            let prefs = state.canvas.prefs;
            if (sessionId) {
                const prev = prefs[sessionId] || { optedOut: false, lastViewedRev: 0 };
                if (mode === "canvas" && prev.optedOut) {
                    // Coming back by hand un-opts-out: the user has shown the
                    // canvas is welcome again, so future draws may flip.
                    prefs = { ...prefs, [sessionId]: { ...prev, optedOut: false } };
                } else if (mode === "panes" && action.manual && !prev.optedOut) {
                    prefs = { ...prefs, [sessionId]: { ...prev, optedOut: true } };
                }
            }
            return {
                ...state,
                ui: { ...state.ui, rightPaneMode: mode, canvasOpen: mode === "canvas" },
                canvas: { ...state.canvas, prefs },
            };
        }

        // Canvas as a column of its own. Same opt-out bookkeeping as the old
        // mode switch above — closing by hand still says "do not flip me back",
        // opening by hand still withdraws that — but closing the canvas no
        // longer implies showing anything else, because Diagnostics is now a
        // separate column with its own toggle.
        //
        // `open` may be omitted to mean "toggle".
        case "ui/canvasOpen": {
            const open = typeof action.open === "boolean" ? action.open : !state.ui.canvasOpen;
            const sessionId = action.sessionId || state.sessions.activeSessionId || null;
            let prefs = state.canvas.prefs;
            if (sessionId) {
                const prev = prefs[sessionId] || { optedOut: false, lastViewedRev: 0 };
                if (open && prev.optedOut) {
                    prefs = { ...prefs, [sessionId]: { ...prev, optedOut: false } };
                } else if (!open && action.manual && !prev.optedOut) {
                    prefs = { ...prefs, [sessionId]: { ...prev, optedOut: true } };
                }
            }
            return {
                ...state,
                // rightPaneMode is kept in step for anything still reading it.
                // Closing always drops full screen: otherwise the next open
                // comes back covering the workspace with no warning.
                ui: {
                    ...state.ui,
                    canvasOpen: open,
                    rightPaneMode: open ? "canvas" : "panes",
                    ...(open ? {} : { canvasMaximized: false, canvasZen: false }),
                },
                canvas: { ...state.canvas, prefs },
            };
        }

        // Diagnostics — today's Inspector + Activity, travelling as one column.
        // No canvas bookkeeping: it has nothing to do with the canvas, which is
        // the whole point of splitting the old enum in two.
        // Zen: sessions hidden, chat a narrow rail, canvas the workbench.
        // Turning it on opens the canvas; it means nothing without one.
        case "ui/canvasZen": {
            const on = typeof action.on === "boolean" ? action.on : !state.ui.canvasZen;
            if (on === Boolean(state.ui.canvasZen)) return state;
            return {
                ...state,
                ui: { ...state.ui, canvasZen: on, ...(on ? { canvasOpen: true, rightPaneMode: "canvas" } : {}) },
            };
        }

        // The zen chat-rail width for one session. Clamped so a wild drag can
        // never wedge the rail off screen or crush the canvas.
        case "canvas/zenRail": {
            const sessionId = String(action.sessionId || "").trim();
            const px = Number(action.px);
            if (!sessionId || !Number.isFinite(px)) return state;
            const prev = state.canvas.prefs[sessionId] || { optedOut: false, lastViewedRev: 0 };
            const clamped = Math.max(260, Math.min(720, Math.round(px)));
            return {
                ...state,
                canvas: { ...state.canvas, prefs: { ...state.canvas.prefs, [sessionId]: { ...prev, zenRailPx: clamped } } },
            };
        }

        // Full-screen canvas. The header stays put and the canvas covers the
        // workspace below it, so there is always a way back.
        case "ui/canvasMaximized": {
            const on = typeof action.on === "boolean" ? action.on : !state.ui.canvasMaximized;
            if (on === Boolean(state.ui.canvasMaximized)) return state;
            return { ...state, ui: { ...state.ui, canvasMaximized: on } };
        }

        case "ui/diagnosticsOpen": {
            const open = typeof action.open === "boolean" ? action.open : !state.ui.diagnosticsOpen;
            if (open === state.ui.diagnosticsOpen) return state;
            return { ...state, ui: { ...state.ui, diagnosticsOpen: open } };
        }

        // ── Providers & Budgets ─────────────────────────────────────────
        // The surface itself. It takes the workspace under the header — the
        // same slot as the admin console — so opening it closes the console
        // rather than stacking two full-screen surfaces.
        //
        // `open` may be omitted to mean "toggle". `provider` lets one dispatch
        // open the surface AT a provider, which is what the paused line's link
        // needs: it names the provider that stopped the sessions.
        case "ui/budgetOpen": {
            const open = typeof action.open === "boolean" ? action.open : !state.ui.budgetOpen;
            const provider = action.provider === undefined ? undefined : normalizeProviderName(action.provider);
            const budget = (open && provider !== undefined)
                ? { ...state.budget, selectedProvider: provider }
                : state.budget;
            const closesConsole = open && state.admin.visible;
            if (open === state.ui.budgetOpen && budget === state.budget && !closesConsole) return state;
            return {
                ...state,
                ui: { ...state.ui, budgetOpen: open },
                admin: closesConsole ? { ...state.admin, visible: false } : state.admin,
                budget,
            };
        }

        case "budget/loading": {
            // A re-read while numbers are already on screen is a REFRESH: it
            // must not blank the report someone is reading. Only the very
            // first load gets to show an empty, loading surface.
            const refresh = action.refresh === true || state.budget.loaded === true;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    loading: !refresh,
                    refreshing: refresh,
                    error: null,
                },
            };
        }

        // One successful read. Both payloads are optional so a narrower
        // re-read — the paused list alone, on the background poll — replaces
        // only what it actually fetched.
        case "budget/loaded": {
            const budget = state.budget;
            const hasGrid = Array.isArray(action.grid);
            const grid = hasGrid ? action.grid : budget.grid;
            const dropped = hasGrid
                // A provider that is gone cannot stay selected: its rows and
                // its chart would be a name with nothing behind it.
                && budget.selectedProvider
                && !action.grid.some((row) => row?.providerName === budget.selectedProvider);
            const selectedProvider = dropped ? null : budget.selectedProvider;
            // A per-model limit can go while its provider stays — someone
            // removes that one limit, and its row goes with it. The SCOPE has
            // to be dropped for the same reason the provider is: otherwise
            // the chart keeps that model's bars on screen under the
            // provider's heading and the provider's limit line, which is one
            // subject's numbers labelled as another's.
            const wasScope = budget.selectedScope || "*";
            const scopeGone = hasGrid && !dropped && wasScope !== "*"
                && !action.grid.some((row) => row?.providerName === budget.selectedProvider
                    && row?.rowKind === "model" && row?.scope === wasScope);
            const selectedScope = (dropped || scopeGone) ? "*" : wasScope;
            // But REMEMBER the name. A session stopped on a provider that no
            // longer exists sends its reader here by name, and clearing the
            // selection silently left them on a table with nothing selected
            // and no hint that the name they clicked is the missing thing.
            const missingProvider = dropped
                ? budget.selectedProvider
                : (hasGrid ? null : budget.missingProvider || null);
            return {
                ...state,
                budget: {
                    ...budget,
                    loading: false,
                    refreshing: false,
                    // `loaded` and `error` are claims about the TABLE, so only
                    // a read that carried the table may change them. The
                    // background poll reads the paused list alone; letting it
                    // set `loaded` would turn an unread namespace into "you
                    // have no providers", which is the one confusion this flag
                    // exists to prevent.
                    loaded: hasGrid ? true : budget.loaded,
                    error: hasGrid ? null : budget.error,
                    fetchedAt: hasGrid ? Date.now() : budget.fetchedAt,
                    grid,
                    paused: Array.isArray(action.paused) ? action.paused : budget.paused,
                    pausedError: Array.isArray(action.paused) ? null : budget.pausedError || null,
                    selectedProvider,
                    selectedScope,
                    missingProvider,
                    // The chart belongs to a row that is no longer there —
                    // either the provider or the one model limit under it.
                    series: (selectedProvider === budget.selectedProvider && selectedScope === wasScope)
                        ? budget.series
                        : {
                            provider: null, scope: "*", rangeDays: budget.rangeDays ?? BUDGET_SERIES_DAYS, days: [],
                            loading: false, loaded: false, error: null, fetchedAt: 0,
                        },
                    systemUsage: (selectedProvider === budget.selectedProvider && selectedScope === wasScope)
                        ? budget.systemUsage
                        : {
                            provider: null, scope: "*", rangeDays: budget.rangeDays ?? BUDGET_SERIES_DAYS,
                            totals: null, days: [], breakdown: [],
                            loading: false, loaded: false, error: null, fetchedAt: 0,
                        },
                },
            };
        }

        // Only the WAITING list failed. The table's own numbers were read
        // successfully in the same round, so nothing about them is stale and
        // nothing about them is marked — the waiting line is.
        case "budget/pausedFailed": {
            const message = action.error ? String(action.error?.message || action.error) : "";
            return {
                ...state,
                budget: {
                    ...state.budget,
                    loading: false,
                    refreshing: false,
                    pausedError: message || "Could not read what is waiting",
                },
            };
        }

        // A read that FAILED. Distinct from a read that came back empty:
        // "this provider has no limits" and "we could not find out what its
        // limits are" are different facts, and only one of them is safe to act
        // on. So `loaded` and the previous numbers stay exactly as they were
        // and the error rides alongside them — the view says the read failed
        // rather than drawing zeros.
        case "budget/loadFailed": {
            const message = action.error ? String(action.error?.message || action.error) : "";
            return {
                ...state,
                budget: {
                    ...state.budget,
                    loading: false,
                    refreshing: false,
                    // The server's own words. It writes them for a person and
                    // names the remedy, so passing them through beats any
                    // "something went wrong" this file could invent.
                    error: message || "Could not read providers and budgets",
                },
            };
        }

        // The "show overall usage" tick. It changes which pair of numbers the
        // table prints, never which numbers were read: both pairs are already
        // in `grid`, so this is a render choice and costs no request.
        case "budget/overall": {
            const overall = typeof action.overall === "boolean" ? action.overall : !state.budget.overall;
            if (overall === state.budget.overall) return state;
            return { ...state, budget: { ...state.budget, overall } };
        }

        case "budget/rangeDays": {
            const rangeDays = Number(action.rangeDays);
            if (!BUDGET_SERIES_RANGES.includes(rangeDays) || rangeDays === state.budget.rangeDays) return state;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    rangeDays,
                    series: {
                        provider: null, scope: "*", rangeDays, days: [],
                        loading: false, loaded: false, error: null, fetchedAt: 0,
                    },
                    systemUsage: {
                        provider: null, scope: "*", rangeDays, totals: null, days: [], breakdown: [],
                        loading: false, loaded: false, error: null, fetchedAt: 0,
                    },
                },
            };
        }

        // Selecting a provider expands its model rows and opens its chart.
        // Selecting the one already selected clears the selection, which is
        // how a row collapses again.
        case "budget/selectProvider": {
            const provider = normalizeProviderName(action.provider);
            // '*' is the provider itself; anything else is one of its
            // model-scoped limits, which is a row you can stand on too — the
            // chart then shows that model alone.
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const was = state.budget.selectedProvider;
            const wasScope = state.budget.selectedScope || "*";
            // Clicking the row you are already on clears it: a provider row
            // collapses, a model row falls back to the provider above it.
            let selectedProvider = provider;
            let selectedScope = scope;
            if (provider === was && scope === wasScope) {
                if (scope === "*") { selectedProvider = null; selectedScope = "*"; }
                else { selectedScope = "*"; }
            }
            if (selectedProvider === was && selectedScope === wasScope) return state;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    selectedProvider,
                    selectedScope,
                    // Choosing a row that exists answers the question the
                    // missing name raised, so the line about it goes.
                    missingProvider: null,
                    // The old chart described the old row. Leaving it up under
                    // a new name is the one way this screen could show one
                    // provider's spend labelled as another's — or a whole
                    // provider's spend labelled as one model's.
                    series: {
                        provider: null, scope: "*", rangeDays: state.budget.rangeDays ?? BUDGET_SERIES_DAYS, days: [],
                        loading: false, loaded: false, error: null, fetchedAt: 0,
                    },
                    systemUsage: {
                        provider: null, scope: "*", rangeDays: state.budget.rangeDays ?? BUDGET_SERIES_DAYS,
                        totals: null, days: [], breakdown: [],
                        loading: false, loaded: false, error: null, fetchedAt: 0,
                    },
                },
            };
        }

        case "budget/series/loading": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = Number(action.rangeDays) || state.budget.rangeDays || BUDGET_SERIES_DAYS;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    series: { ...state.budget.series, provider, scope, rangeDays, loading: true, error: null },
                },
            };
        }

        // A response for a provider the reader has already left is dropped.
        // The table and the chart under it must always name the same provider.
        case "budget/series/loaded": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = action.rangeDays === undefined
                ? (state.budget.rangeDays || BUDGET_SERIES_DAYS)
                : Number(action.rangeDays);
            if (provider !== state.budget.selectedProvider) return state;
            // The SCOPE has to match too, or a provider-wide answer that was
            // already in flight paints itself under a model row's heading.
            if (scope !== (state.budget.selectedScope || "*")) return state;
            if (rangeDays !== (state.budget.rangeDays || BUDGET_SERIES_DAYS)) return state;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    series: {
                        provider,
                        scope,
                        rangeDays,
                        days: Array.isArray(action.days) ? action.days : [],
                        loading: false,
                        loaded: true,
                        error: null,
                        fetchedAt: Date.now(),
                    },
                },
            };
        }

        case "budget/series/failed": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = action.rangeDays === undefined
                ? (state.budget.rangeDays || BUDGET_SERIES_DAYS)
                : Number(action.rangeDays);
            if (provider !== state.budget.selectedProvider) return state;
            if (scope !== (state.budget.selectedScope || "*")) return state;
            if (rangeDays !== (state.budget.rangeDays || BUDGET_SERIES_DAYS)) return state;
            const message = action.error ? String(action.error?.message || action.error) : "";
            return {
                ...state,
                budget: {
                    ...state.budget,
                    series: {
                        ...state.budget.series,
                        provider,
                        scope,
                        rangeDays,
                        loading: false,
                        // The numbers already drawn stay put and are marked
                        // old; a failed re-read is not a day with no usage.
                        error: message || "Could not read the daily usage",
                    },
                },
            };
        }

        case "budget/systemUsage/loading": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = Number(action.rangeDays) || state.budget.rangeDays || BUDGET_SERIES_DAYS;
            return {
                ...state,
                budget: {
                    ...state.budget,
                    systemUsage: { ...state.budget.systemUsage, provider, scope, rangeDays, loading: true, error: null },
                },
            };
        }

        case "budget/systemUsage/loaded": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = action.rangeDays === undefined
                ? (state.budget.rangeDays || BUDGET_SERIES_DAYS)
                : Number(action.rangeDays);
            if (provider !== state.budget.selectedProvider || scope !== (state.budget.selectedScope || "*")) return state;
            if (rangeDays !== (state.budget.rangeDays || BUDGET_SERIES_DAYS)) return state;
            const report = action.report || {};
            return {
                ...state,
                budget: {
                    ...state.budget,
                    systemUsage: {
                        provider,
                        scope,
                        rangeDays,
                        totals: report.totals || { tokensTotal: 0, turns: 0, sessions: 0 },
                        days: Array.isArray(report.daily) ? report.daily : [],
                        breakdown: Array.isArray(report.breakdown) ? report.breakdown : [],
                        loading: false,
                        loaded: true,
                        error: null,
                        fetchedAt: Date.now(),
                    },
                },
            };
        }

        case "budget/systemUsage/failed": {
            const provider = normalizeProviderName(action.provider);
            const scope = typeof action.scope === "string" && action.scope ? action.scope : "*";
            const rangeDays = action.rangeDays === undefined
                ? (state.budget.rangeDays || BUDGET_SERIES_DAYS)
                : Number(action.rangeDays);
            if (provider !== state.budget.selectedProvider || scope !== (state.budget.selectedScope || "*")) return state;
            if (rangeDays !== (state.budget.rangeDays || BUDGET_SERIES_DAYS)) return state;
            const message = action.error ? String(action.error?.message || action.error) : "";
            return {
                ...state,
                budget: {
                    ...state.budget,
                    systemUsage: {
                        ...state.budget.systemUsage,
                        provider,
                        scope,
                        rangeDays,
                        loading: false,
                        error: message || "Could not read system spend",
                    },
                },
            };
        }

        // The agent-driven flip. The guards (active session, freshness,
        // opt-out) live in the controller; by the time this dispatches the
        // flip is decided. flipSeq ticks even when the mode is already
        // "canvas" — a phone can be off the canvas tab while the persisted
        // mode still says canvas, and the tick is what brings its tab back.
        case "canvas/flip": {
            const slot = Number.isInteger(Number(action.slot)) && Number(action.slot) >= 1 && Number(action.slot) <= 5
                ? Number(action.slot) : 1;
            return {
                ...state,
                // Opens the canvas column ON THE SLOT THAT DREW; leaves
                // Diagnostics exactly as the user left it. An agent drawing
                // must not close their panels.
                ui: { ...state.ui, rightPaneMode: "canvas", canvasOpen: true, canvasSlot: slot },
                canvas: { ...state.canvas, flipSeq: (state.canvas.flipSeq || 0) + 1 },
            };
        }

        // Which of the active session's canvases the pane shows. In-memory
        // only: a reload lands on slot 1 (or wherever the next flip points).
        case "ui/canvasSlot": {
            const slot = Number.isInteger(Number(action.slot)) && Number(action.slot) >= 1 && Number(action.slot) <= 5
                ? Number(action.slot) : 1;
            if (slot === (state.ui.canvasSlot || 1)) return state;
            return { ...state, ui: { ...state.ui, canvasSlot: slot } };
        }

        // The surface's receipt: revision `rev` (a draw) and/or `dataRev` (a
        // tick) actually rendered on screen. Both feed the unseen badge.
        case "canvas/viewed": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const rev = Number(action.rev);
            const dataRev = Number(action.dataRev);
            const key = canvasKey(sessionId, action.slot);
            const prev = state.canvas.prefs[key] || { optedOut: false, lastViewedRev: 0, lastViewedDataRev: 0 };
            const nextRev = Number.isFinite(rev) && rev > (prev.lastViewedRev || 0) ? rev : (prev.lastViewedRev || 0);
            const nextDataRev = Number.isFinite(dataRev) && dataRev > (prev.lastViewedDataRev || 0) ? dataRev : (prev.lastViewedDataRev || 0);
            if (nextRev === (prev.lastViewedRev || 0) && nextDataRev === (prev.lastViewedDataRev || 0)) return state;
            return {
                ...state,
                canvas: {
                    ...state.canvas,
                    prefs: { ...state.canvas.prefs, [key]: { ...prev, lastViewedRev: nextRev, lastViewedDataRev: nextDataRev } },
                },
            };
        }

        // The sessions-list seed: rev+name per slot from session_canvases,
        // merged under the live entries. Never regresses a rev a live event
        // already delivered, never sets snapshotLoaded (the full snapshot —
        // note, contract, data replay — still loads on selection).
        case "canvas/seed": {
            const entries = Array.isArray(action.entries) ? action.entries : [];
            if (!entries.length) return state;
            let next = null;
            for (const e of entries) {
                const sessionId = String(e?.sessionId || "").trim();
                const rev = Number(e?.latestRev);
                const slotN = Number(e?.slot);
                if (!sessionId || !Number.isFinite(rev) || rev <= 0) continue;
                if (!Number.isInteger(slotN) || slotN < 1 || slotN > 5) continue;
                const key = canvasKey(sessionId, slotN);
                const existing = (next || state.canvas.bySessionId)[key] || {};
                if ((existing.latestRev || 0) >= rev && existing.name !== undefined) continue;
                next = next || { ...state.canvas.bySessionId };
                next[key] = {
                    ...existing,
                    slot: slotN,
                    latestRev: Math.max(existing.latestRev || 0, rev),
                    ...(typeof e.name === "string" && existing.name === undefined ? { name: e.name } : {}),
                    ...(existing.sizeBytes === undefined && e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
                };
            }
            if (!next) return state;
            return { ...state, canvas: { ...state.canvas, bySessionId: next } };
        }

        case "canvas/updated": {
            const sessionId = String(action.sessionId || "").trim();
            const rev = Number(action.rev);
            if (!sessionId || !Number.isFinite(rev) || rev <= 0) return state;
            const slot = Number.isInteger(Number(action.slot)) && Number(action.slot) >= 1 && Number(action.slot) <= 5
                ? Number(action.slot) : 1;
            const key = canvasKey(sessionId, slot);
            const existing = state.canvas.bySessionId[key] || {};
            // Monotonic: replays and out-of-order merges must never regress
            // the known revision (freshness gates the FLIP, never the data).
            if ((existing.latestRev || 0) >= rev) return state;
            return {
                ...state,
                canvas: {
                    ...state.canvas,
                    bySessionId: {
                        ...state.canvas.bySessionId,
                        [key]: {
                            ...existing,
                            slot,
                            ...(typeof action.name === "string" ? { name: action.name } : {}),
                            latestRev: rev,
                            note: typeof action.note === "string" ? action.note : "",
                            sizeBytes: Number.isFinite(Number(action.sizeBytes)) ? Number(action.sizeBytes) : null,
                            // The contract belongs to the revision: a draw
                            // without one REVOKES interactivity (default
                            // closed), so no carry-over from the previous rev.
                            responseContract: action.responseContract && typeof action.responseContract === "object"
                                ? action.responseContract
                                : null,
                        },
                    },
                },
            };
        }

        // A data tick: content for the page, in place. Never flips (ticks do
        // not interrupt) — but it DOES count toward the unseen badge via
        // latestDataRev vs lastViewedDataRev. Monotonic like the draw rev.
        case "canvas/data": {
            const sessionId = String(action.sessionId || "").trim();
            const slot = Number.isInteger(Number(action.slot)) && Number(action.slot) >= 1 && Number(action.slot) <= 5
                ? Number(action.slot) : 1;
            const key = canvasKey(sessionId, slot);
            const dataRev = Number(action.dataRev);
            if (!sessionId || !Number.isFinite(dataRev) || dataRev <= 0) return state;
            const existing = state.canvas.bySessionId[key] || {};
            const planeSeq = Number(action.planeSeq);
            const isPlane = Number.isFinite(planeSeq) && planeSeq > 0;
            // Plane takeover: once a slot has seen ONE plane-fed tick, that
            // lineage owns the slot. Plane ticks order by planeSeq (their
            // numbering restarts relative to legacy dataRev, so the numeric
            // guard below would wrongly starve them); legacy dual-written
            // events for a plane-owned slot are strictly staler copies of
            // state the plane already delivered — drop them.
            if (isPlane) {
                if ((existing.planeSeq || 0) >= planeSeq) return state;
            } else {
                if (existing.planeSeq) return state;
                if ((existing.latestDataRev || 0) >= dataRev) return state;
            }
            return {
                ...state,
                canvas: {
                    ...state.canvas,
                    bySessionId: {
                        ...state.canvas.bySessionId,
                        [key]: {
                            ...existing,
                            // The DISPLAYED tick number stays monotonic across
                            // the takeover: viewed-marking and badges compare
                            // against it, and a smaller number would replay
                            // as "already seen".
                            latestDataRev: Math.max(dataRev, existing.latestDataRev || 0),
                            ...(isPlane ? { planeSeq } : {}),
                            dataPayload: action.payload && typeof action.payload === "object" ? action.payload : null,
                            // The patch that produced this state, for pages
                            // that opt into targeted updates. Whole-state
                            // ticks clear it — there is no delta to hand out.
                            dataPatch: isPlane && action.patch && typeof action.patch === "object" ? action.patch : null,
                        },
                    },
                },
            };
        }

        case "canvas/planeReleased": {
            // The plane died for this session: release the takeover on every
            // slot so legacy durable ticks resume applying. Displayed tick
            // numbers (latestDataRev) survive, so stale legacy dupes still
            // drop by ordinary ordering while fresh ones flow.
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            let changed = false;
            const nextBySession = { ...state.canvas.bySessionId };
            for (let slot = 1; slot <= 5; slot++) {
                const key = canvasKey(sessionId, slot);
                const entry = nextBySession[key];
                if (entry && entry.planeSeq) {
                    const { planeSeq: _released, ...rest } = entry;
                    nextBySession[key] = rest;
                    changed = true;
                }
            }
            if (!changed) return state;
            return { ...state, canvas: { ...state.canvas, bySessionId: nextBySession } };
        }

        case "canvas/snapshot": {
            const sessionId = String(action.sessionId || "").trim();
            if (!sessionId) return state;
            const slot = Number.isInteger(Number(action.slot)) && Number(action.slot) >= 1 && Number(action.slot) <= 5
                ? Number(action.slot) : 1;
            const key = canvasKey(sessionId, slot);
            const existing = state.canvas.bySessionId[key] || {};
            const rev = Number(action.rev) || 0;
            return {
                ...state,
                canvas: {
                    ...state.canvas,
                    bySessionId: {
                        ...state.canvas.bySessionId,
                        [key]: {
                            ...existing,
                            slot,
                            ...(typeof action.name === "string" && ((existing.latestRev || 0) <= rev) ? { name: action.name } : {}),
                            // Events may have beaten the snapshot; never regress.
                            latestRev: Math.max(existing.latestRev || 0, rev),
                            note: (existing.latestRev || 0) > rev ? existing.note : (typeof action.note === "string" ? action.note : existing.note || ""),
                            sizeBytes: (existing.latestRev || 0) > rev ? existing.sizeBytes : (Number.isFinite(Number(action.sizeBytes)) ? Number(action.sizeBytes) : existing.sizeBytes ?? null),
                            responseContract: (existing.latestRev || 0) > rev
                                ? (existing.responseContract ?? null)
                                : (action.responseContract && typeof action.responseContract === "object" ? action.responseContract : null),
                            snapshotLoaded: true,
                        },
                    },
                },
            };
        }

        // Continuity break (windowed bulk reload replaced gap-free replay):
        // the memoized snapshot can no longer be trusted — re-take on next need.
        case "canvas/snapshotInvalidate": {
            const sessionId = String(action.sessionId || "").trim();
            const existing = state.canvas.bySessionId[sessionId];
            if (!sessionId || !existing?.snapshotLoaded) return state;
            // Slots 2-5 of the same session invalidate with slot 1: the flag
            // that gates re-take lives on the slot-1 entry.
            return {
                ...state,
                canvas: {
                    ...state.canvas,
                    bySessionId: {
                        ...state.canvas.bySessionId,
                        [sessionId]: { ...existing, snapshotLoaded: false },
                    },
                },
            };
        }

        case "files/htmlViewMode":
            return {
                ...state,
                files: {
                    ...state.files,
                    htmlViewMode: action.mode === "source" ? "source" : "rendered",
                },
            };

        case "files/htmlFitWidth":
            return {
                ...state,
                files: {
                    ...state.files,
                    htmlFitWidth: Boolean(action.enabled),
                },
            };

        // Clamped here rather than at the call site so every entry point —
        // buttons, keyboard, a restored profile — lands in the same range.
        case "files/htmlZoom": {
            const requested = Number(action.zoom);
            const zoom = Number.isFinite(requested)
                ? Math.min(3, Math.max(0.5, Math.round(requested * 100) / 100))
                : 1;
            return { ...state, files: { ...state.files, htmlZoom: zoom } };
        }

        case "files/clearMarks":
            return { ...state, files: { ...state.files, markedIds: [] } };

        case "files/selectGlobal":
            return {
                ...state,
                files: {
                    ...state.files,
                    selectedArtifactId: action.artifactId || null,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };

        case "files/previewLoading": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    ...(current.previews?.[action.filename] || {}),
                    loading: true,
                    error: null,
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/previewLoaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    loading: false,
                    error: null,
                    content: action.content || "",
                    contentType: action.contentType || "text/plain",
                    renderMode: action.renderMode || "text",
                    isBinary: action.isBinary === true,
                    sizeBytes: Number.isFinite(action.sizeBytes) ? action.sizeBytes : null,
                    uploadedAt: action.uploadedAt || "",
                    source: action.source || "agent",
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/previewError": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const previews = {
                ...(current.previews || {}),
                [action.filename]: {
                    ...(current.previews?.[action.filename] || {}),
                    loading: false,
                    error: action.error || "Failed to load file preview",
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                previews,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/downloaded": {
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: action.filename || null,
            };
            const downloads = {
                ...(current.downloads || {}),
                [action.filename]: {
                    localPath: action.localPath || null,
                    downloadedAt: action.downloadedAt || Date.now(),
                },
            };
            bySessionId[action.sessionId] = {
                ...current,
                downloads,
            };
            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                },
            };
        }

        case "files/deleted": {
            // Fall through to the existing handling, but drop the deleted id
            // from the marks first so a bulk delete cannot leave phantoms.
            state = {
                ...state,
                files: {
                    ...state.files,
                    markedIds: (state.files.markedIds || [])
                        .filter((id) => id !== `${action.sessionId}/${action.filename}`),
                },
            };
            const bySessionId = cloneFilesBySessionId(state.files.bySessionId);
            const current = bySessionId[action.sessionId] || {
                entries: [],
                previews: {},
                downloads: {},
                selectedFilename: null,
            };
            const entries = normalizeArtifactEntries(current.entries).filter((entry) => entry.filename !== action.filename);
            const nextSelectedFilename = current.selectedFilename === action.filename
                ? (entries[0]?.filename || null)
                : current.selectedFilename;
            const { [action.filename]: _deletedPreview, ...previews } = current.previews || {};
            const { [action.filename]: _deletedDownload, ...downloads } = current.downloads || {};
            const deletedArtifactId = action.sessionId && action.filename
                ? `${action.sessionId}/${action.filename}`
                : null;

            bySessionId[action.sessionId] = {
                ...current,
                entries,
                previews,
                downloads,
                selectedFilename: nextSelectedFilename,
            };

            return {
                ...state,
                files: {
                    ...state.files,
                    bySessionId,
                    selectedArtifactId: state.files.selectedArtifactId === deletedArtifactId
                        ? (nextSelectedFilename ? `${action.sessionId}/${nextSelectedFilename}` : null)
                        : state.files.selectedArtifactId,
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };
        }

        case "files/fullscreen":
            return {
                ...state,
                files: {
                    ...state.files,
                    fullscreen: Boolean(action.fullscreen),
                },
                ui: Boolean(action.fullscreen)
                    ? {
                        ...state.ui,
                        focusRegion: "inspector",
                        fullscreenPane: null,
                    }
                    : state.ui,
            };

        case "files/filter":
            return {
                ...state,
                files: {
                    ...state.files,
                    filter: {
                        ...normalizeFilesFilter(state.files.filter),
                        ...normalizeFilesFilter(action.filter),
                    },
                    ...(normalizeFilesFilter(action.filter).scope === "selectedSession"
                        ? {}
                        : {
                            selectedArtifactId: state.files.selectedArtifactId || null,
                        }),
                },
                ui: {
                    ...state.ui,
                    scroll: {
                        ...state.ui.scroll,
                        filePreview: 0,
                    },
                },
            };

        case "logs/config":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    available: Boolean(action.available),
                    availabilityReason: action.availabilityReason || state.logs.availabilityReason,
                },
            };

        case "logs/tailing":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    tailing: Boolean(action.tailing),
                },
            };

        case "logs/filter":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    filter: {
                        ...state.logs.filter,
                        ...(action.filter || {}),
                    },
                },
            };

        case "logs/set":
            return {
                ...state,
                logs: {
                    ...state.logs,
                    entries: normalizeLogEntries(action.entries),
                },
            };

        case "logs/append": {
            const newEntries = (Array.isArray(action.entries) ? action.entries : [action.entry]).filter(Boolean);
            if (newEntries.length === 0) return state;
            const combined = [...(state.logs.entries || []), ...newEntries];
            const capped = combined.length > 1000 ? combined.slice(-1000) : combined;
            return {
                ...state,
                logs: {
                    ...state.logs,
                    entries: capped,
                },
            };
        }

        default:
            return state;
    }
}
