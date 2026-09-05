import { adminCanAccessResource } from "./admin-scope.js";

/**
 * Session-tree access predicate — the ONE implementation, shared by every
 * surface that has to answer "may this principal touch this session?".
 *
 * It lived in `packages/app/web/authz.js` and served the portal alone. The
 * worker now needs the same answer: agent tools that read sessions must reach
 * exactly what their session's OWNER could reach, and a second implementation
 * would be a second thing to get wrong. So the pure half moved here, into the
 * dependency both sides already have. The portal re-exports it, unchanged.
 *
 * Deliberately pure: no I/O, no env, no database. Callers fetch the access
 * snapshot (`catalog.getSessionAccess`) and pass it in. That is what makes it
 * usable from an Express route and from inside a tool handler.
 *
 * @module
 */

/**
 * @typedef {object} SessionAccessSnapshot
 * @property {string}  rootSessionId
 * @property {boolean} isSystem
 * @property {"private"|"shared_read"|"shared_write"} visibility
 * @property {{displayName?: string|null, email?: string|null, subject?: string|null}|null} owner
 * @property {boolean} viewerIsOwner
 * @property {"read"|"write"|null} viewerShareAccess
 */

export const SESSION_VISIBILITY_VALUES = Object.freeze(["private", "shared_read", "shared_write"]);

const VISIBILITY_SET = new Set(SESSION_VISIBILITY_VALUES);

export function normalizeVisibility(value, fallback) {
    const normalized = String(value || "").trim().toLowerCase();
    return VISIBILITY_SET.has(normalized) ? normalized : fallback;
}

/**
 * Are system sessions readable by ordinary users on this deployment?
 *
 * The portal reads `SESSIONS_SYSTEM_VISIBILITY` for exactly this; the worker
 * must reach the same answer or the same user would see the PilotSwarm root
 * in their session list but be told it does not exist by an agent. Default
 * "read" — hiding them is the opt-in.
 */
export function systemSessionsReadable(env = (typeof process !== "undefined" ? process.env : {})) {
    return String(env?.SESSIONS_SYSTEM_VISIBILITY || "").trim().toLowerCase() !== "admin";
}

function ownerLabel(snapshot) {
    return snapshot?.owner?.displayName || snapshot?.owner?.email || snapshot?.owner?.subject || "another user";
}

/**
 * The caller's relation to a session tree, recorded on message payloads and
 * shown to the agent in multi-writer sessions.
 */
export function relationFor(snapshot, { isAdmin, adminScope = "unrestricted" } = {}) {
    if (snapshot?.viewerIsOwner) return "owner";
    if (adminCanAccessResource(isAdmin, adminScope, snapshot?.isSystem)) return "admin";
    return "collaborator";
}

/**
 * Evaluate one session-scoped access class against an access snapshot.
 *
 * @param {"session:read"|"session:write"|"session:manage"|"session:destroy"|"session:share"} accessClass
 * @param {SessionAccessSnapshot|null} snapshot  result of getSessionAccess (null = missing/deleted)
 * @param {{isAdmin?: boolean, systemReadable?: boolean}} [opts]
 * @returns {{allowed: boolean, notFound?: boolean, reason?: string, breakGlass?: boolean}}
 */
export function evaluateSessionAccess(accessClass, snapshot, { isAdmin = false, systemReadable = true, adminScope = "unrestricted" } = {}) {
    if (!snapshot) {
        // Missing/deleted session: let the underlying operation produce its
        // own not-found; nothing to protect.
        return { allowed: true };
    }

    if (adminCanAccessResource(isAdmin, adminScope, snapshot.isSystem)) {
        // Admins pass everything; flag break-glass when this would have been
        // invisible to a plain user in the same position.
        const wouldBeInvisible = !snapshot.viewerIsOwner
            && !snapshot.isSystem
            && snapshot.visibility === "private"
            && !snapshot.viewerShareAccess;
        return { allowed: true, breakGlass: wouldBeInvisible };
    }

    const isRead = accessClass === "session:read";

    if (snapshot.isSystem) {
        // When system sessions are hidden from users, every class 404s so a
        // write attempt can't confirm the session exists (review LOW-2).
        if (!systemReadable) return { allowed: false, notFound: true };
        if (isRead) return { allowed: true };
        return { allowed: false, reason: "System sessions are managed by administrators." };
    }

    const canRead = snapshot.viewerIsOwner
        || snapshot.visibility === "shared_read"
        || snapshot.visibility === "shared_write"
        || Boolean(snapshot.viewerShareAccess);

    if (isRead) {
        return canRead ? { allowed: true } : { allowed: false, notFound: true };
    }

    // Anything beyond read on an unreadable session is also a 404 — the
    // caller must not learn the session exists from the error shape.
    if (!canRead) return { allowed: false, notFound: true };

    if (accessClass === "session:write") {
        const canWrite = snapshot.viewerIsOwner
            || snapshot.visibility === "shared_write"
            || snapshot.viewerShareAccess === "write";
        return canWrite
            ? { allowed: true }
            : { allowed: false, reason: `You have read access to this session; write access is required. Ask ${ownerLabel(snapshot)} for write access.` };
    }

    // manage / destroy / share: owner only (admin handled above).
    return snapshot.viewerIsOwner
        ? { allowed: true }
        : { allowed: false, reason: `Only the session owner (${ownerLabel(snapshot)})${adminScope === "unrestricted" ? " or an admin" : ""} can do this.` };
}

/**
 * Archive (dehydrated session tar) access — owner or admin ONLY, never a
 * share. Deliberately NOT `evaluateSessionAccess("session:read", …)`.
 *
 * The tar is raw session state: pre-compaction history the UI no longer
 * displays, full tool-call arguments (which can carry secrets a user pasted),
 * internal scratch. Sharing a session shares a *view* of a conversation; it
 * was never an offer of the substrate underneath. See the Agent Manager
 * proposal, §15 A3.
 *
 * @param {SessionAccessSnapshot|null} snapshot
 * @param {{isAdmin?: boolean}} [opts]
 * @returns {{allowed: boolean, notFound?: boolean, reason?: string, breakGlass?: boolean}}
 */
export function evaluateArchiveAccess(snapshot, { isAdmin = false, adminScope = "unrestricted" } = {}) {
    if (!snapshot) return { allowed: true };
    if (adminCanAccessResource(isAdmin, adminScope, snapshot.isSystem)) {
        // Reading someone else's raw session state is exactly what the
        // authz_audit table calls a break-glass read.
        return { allowed: true, breakGlass: !snapshot.viewerIsOwner };
    }
    if (snapshot.viewerIsOwner) return { allowed: true };
    if (snapshot.viewerShareAccess || snapshot.visibility !== "private") {
        return {
            allowed: false,
            reason:
                (adminScope === "cluster" ? "Session archives are available to the session owner only. " : "Session archives are available to the session owner and administrators only. ")
                + "A share grants the conversation, not the raw session state behind it.",
        };
    }
    return { allowed: false, notFound: true };
}

/**
 * How old a recorded sign-in role may be and still confer privilege.
 *
 * The stored role is an OBSERVATION — the last thing the identity provider
 * told the portal — so it decays. An active portal user re-confirms it every
 * few minutes; a principal who has not authenticated within this window is
 * treated as a plain user, which is the fail-closed direction.
 *
 * The failure this bounds is concrete: an admin is demoted in the identity
 * provider and never opens the portal again, while a cron-driven session of
 * theirs keeps firing turns. Without a ceiling that session keeps fleet reach
 * forever, because nothing would ever contradict the stored `admin`.
 */
export const ROLE_OBSERVATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The only principal that may ever hold the `anonymous` role.
 *
 * `anonymous` is issued by `authorizePrincipal(null, policy)` — the
 * auth-disabled branch — and that branch pairs it with
 * `createNoAuthUnknownPrincipal()`, which is this exact identity. So the
 * binding below is not a new restriction; it is the existing invariant,
 * written down where it is relied upon.
 */
const ANONYMOUS_PRINCIPAL = { provider: "none", subject: "unknown" };

/**
 * Does a recorded sign-in role still make this principal an administrator?
 *
 * Separate from `evaluateSessionAccess` on purpose: that answers "may this
 * viewer touch this session", this answers "is this viewer privileged at all".
 * It is a pure function so the fail-closed paths can be tested without a
 * database, a worker, or a clock.
 *
 * `anonymous` counts as admin, because an auth-disabled deployment is a
 * trusted one and the portal already grants it full access there. A worker
 * that disagreed would make agents quietly more restricted than the UI beside
 * them.
 *
 * But `anonymous` is a NAME being trusted to GRANT, which is the one direction
 * the proposal's own A10 rule says is never safe — a forged name can only put
 * you inside a denylist, never outside one, and this is the opposite shape. So
 * it is admitted only for the single principal that can legitimately carry it.
 * Nothing today can write `anonymous` for a named user; this makes that a
 * property of the code rather than a property of three other files staying
 * the way they are.
 *
 * Every unknown resolves to `false`: no role, an unrecognized role, a missing
 * timestamp, or an observation past the ceiling.
 *
 * @param {{role?: string|null, seenAt?: Date|null}|null} observation
 * @param {{now?: number, maxAgeMs?: number, principal?: {provider?: string, subject?: string}|null}} [opts]
 * @returns {{isAdmin: boolean, reason?: string}}
 */
export function evaluateRoleObservation(observation, { now = Date.now(), maxAgeMs = ROLE_OBSERVATION_MAX_AGE_MS, principal = null } = {}) {
    const role = observation?.role ?? null;
    if (role !== "admin" && role !== "anonymous") {
        return { isAdmin: false, reason: role ? `role is '${role}'` : "no role recorded" };
    }
    if (role === "anonymous"
        && !(principal
            && principal.provider === ANONYMOUS_PRINCIPAL.provider
            && principal.subject === ANONYMOUS_PRINCIPAL.subject)) {
        return {
            isAdmin: false,
            reason: "the anonymous role belongs to the auth-disabled principal only",
        };
    }
    const seenAt = observation?.seenAt ?? null;
    if (!(seenAt instanceof Date) || Number.isNaN(seenAt.getTime())) {
        return { isAdmin: false, reason: "role has no observation timestamp" };
    }
    // A future timestamp (clock skew between portal and worker) is not
    // suspicious enough to refuse, but it must never extend the window
    // either — which comparing the elapsed age against the ceiling already
    // guarantees, since a negative age is under it.
    const age = now - seenAt.getTime();
    if (age > maxAgeMs) {
        return { isAdmin: false, reason: `role observation is stale (${Math.floor(age / 3600_000)}h old)` };
    }
    return { isAdmin: true };
}
