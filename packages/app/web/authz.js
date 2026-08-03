import {
    OPERATIONS,
    evaluateSessionAccess,
    normalizeVisibility,
    relationFor,
    SESSION_VISIBILITY_VALUES,
} from "pilotswarm-sdk/api";

// The session-tree predicate now lives in the SDK so the WORKER evaluates the
// same rules for agent tools (Agent Manager proposal §4). Re-exported here so
// every existing import of this module keeps working unchanged.
export { evaluateSessionAccess, normalizeVisibility, relationFor };

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

export function loadAuthzConfig(env = process.env) {
    const rawDefault = String(env.SESSIONS_DEFAULT_VISIBILITY || "").trim().toLowerCase();
    const visibilityValues = new Set(SESSION_VISIBILITY_VALUES);
    return {
        enforce: parseBooleanEnv(env.AUTHZ_ENFORCE_OWNERSHIP, false),
        defaultVisibility: visibilityValues.has(rawDefault) ? rawDefault : "private",
        // "read" (default): system sessions are metadata/content-visible to
        // every admitted user, interaction stays admin-only. "admin": hidden.
        systemVisibility: String(env.SESSIONS_SYSTEM_VISIBILITY || "").trim().toLowerCase() === "admin" ? "admin" : "read",
    };
}

// Every dispatchable method now has an OPERATIONS row — copyArtifact,
// setArtifactPinned and readArtifactBase64 were the last /api/rpc-only
// stragglers (same access classes, now declared in the table). The legacy
// /api/rpc path keeps working: it resolves access through this same map.
const ACCESS_BY_METHOD = new Map(OPERATIONS.map((op) => [op.name, { access: op.access, sessionParam: op.sessionParam || "sessionId" }]));

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

