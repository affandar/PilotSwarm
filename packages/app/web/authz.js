import { OPERATIONS } from "pilotswarm-sdk/api";

/**
 * Ownership/visibility authorization for the portal runtime
 * (docs/proposals/user-admin-security-model.md).
 *
 * The protocol table classifies every operation (`op.access`); this module
 * evaluates the session-tree predicate for the classes that need a resource
 * lookup. `runtime.call()` is the single enforcement point — both the
 * generated /api/v1 routes and the legacy /api/rpc dispatcher land there.
 *
 * Dark launch: with AUTHZ_ENFORCE_OWNERSHIP=false (the default) every
 * decision is computed and would-be denials are recorded in the authz audit
 * table, but nothing is blocked. Flipping the env to true makes the same
 * decisions enforcing — the audit stream is the pre-flip verification.
 */

function parseBooleanEnv(value, defaultValue) {
    if (value == null || value === "") return defaultValue;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

const VISIBILITY_VALUES = new Set(["private", "shared_read", "shared_write"]);

export function loadAuthzConfig(env = process.env) {
    const rawDefault = String(env.SESSIONS_DEFAULT_VISIBILITY || "").trim().toLowerCase();
    return {
        enforce: parseBooleanEnv(env.AUTHZ_ENFORCE_OWNERSHIP, false),
        defaultVisibility: VISIBILITY_VALUES.has(rawDefault) ? rawDefault : "private",
        // "read" (default): system sessions are metadata/content-visible to
        // every admitted user, interaction stays admin-only. "admin": hidden.
        systemVisibility: String(env.SESSIONS_SYSTEM_VISIBILITY || "").trim().toLowerCase() === "admin" ? "admin" : "read",
    };
}

export function normalizeVisibility(value, fallback) {
    const normalized = String(value || "").trim().toLowerCase();
    return VISIBILITY_VALUES.has(normalized) ? normalized : fallback;
}

// Methods reachable only through /api/rpc (not in the OPERATIONS table).
const RPC_ONLY_ACCESS = {
    copyArtifact: "session:copy",
    setArtifactPinned: "session:manage",
    readArtifactBase64: "session:read",
};

const ACCESS_BY_METHOD = new Map(OPERATIONS.map((op) => [op.name, { access: op.access, sessionParam: op.sessionParam || "sessionId" }]));
for (const [name, access] of Object.entries(RPC_ONLY_ACCESS)) {
    if (!ACCESS_BY_METHOD.has(name)) ACCESS_BY_METHOD.set(name, { access, sessionParam: "sessionId" });
}

export function getMethodAccess(method) {
    return ACCESS_BY_METHOD.get(method) || null;
}

export function forbiddenError(message) {
    return Object.assign(new Error(message), { code: "FORBIDDEN", status: 403 });
}

export function notFoundError() {
    // Unreadable point-lookups report NOT_FOUND, not FORBIDDEN — an admitted
    // caller must not be able to probe which session ids exist.
    return Object.assign(new Error("Session not found."), { code: "NOT_FOUND", status: 404 });
}

function ownerLabel(snapshot) {
    return snapshot?.owner?.displayName || snapshot?.owner?.email || snapshot?.owner?.subject || "another user";
}

/**
 * The caller's relation to a session tree, recorded on message payloads and
 * shown to the agent in multi-writer sessions.
 */
export function relationFor(snapshot, { isAdmin } = {}) {
    if (snapshot?.viewerIsOwner) return "owner";
    if (isAdmin) return "admin";
    return "collaborator";
}

/**
 * Evaluate one session-scoped access class against an access snapshot.
 *
 * @param accessClass "session:read" | "session:write" | "session:manage" | "session:destroy" | "session:share"
 * @param snapshot    result of getSessionAccess (null = missing/deleted session)
 * @param opts        { isAdmin, systemReadable }
 * @returns {{ allowed: boolean, notFound?: boolean, reason?: string, breakGlass?: boolean }}
 */
export function evaluateSessionAccess(accessClass, snapshot, { isAdmin = false, systemReadable = true } = {}) {
    if (!snapshot) {
        // Missing/deleted session: let the underlying operation produce its
        // own not-found; nothing to protect.
        return { allowed: true };
    }

    if (isAdmin) {
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
        : { allowed: false, reason: `Only the session owner (${ownerLabel(snapshot)}) or an admin can do this.` };
}
