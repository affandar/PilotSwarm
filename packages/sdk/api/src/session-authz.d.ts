/**
 * Types for the shared session-tree access predicate.
 *
 * The implementation is plain ESM JS (it is imported by the portal, which is
 * not TypeScript), so the worker needs this to consume it without `any`.
 * Typing matters more than usual here: `allowed` and `notFound` mean opposite
 * things to a caller, and an untyped decision object is one typo away from a
 * gate that always passes.
 */

import type { AdminScope } from "./admin-scope.js";

export interface SessionAccessSnapshot {
    rootSessionId?: string;
    isSystem: boolean;
    visibility: "private" | "shared_read" | "shared_write";
    owner: { displayName?: string | null; email?: string | null; subject?: string | null } | null;
    viewerIsOwner: boolean;
    viewerShareAccess: "read" | "write" | null;
}

export interface SessionAccessDecision {
    allowed: boolean;
    /** Report NOT_FOUND rather than FORBIDDEN — an admitted caller must not be able to probe which session ids exist. */
    notFound?: boolean;
    reason?: string;
    /** An admin reached something a plain user in the same position could not see. Audit it. */
    breakGlass?: boolean;
}

export type SessionAccessClass =
    | "session:read"
    | "session:write"
    | "session:manage"
    | "session:destroy"
    | "session:share";

export declare const SESSION_VISIBILITY_VALUES: readonly string[];

export declare function normalizeVisibility(value: unknown, fallback: string): string;

/** Whether ordinary users may READ system sessions (SESSIONS_SYSTEM_VISIBILITY; default true). */
export declare function systemSessionsReadable(env?: Record<string, string | undefined>): boolean;

export declare function relationFor(
    snapshot: SessionAccessSnapshot | null,
    opts?: { isAdmin?: boolean; adminScope?: AdminScope },
): "owner" | "admin" | "collaborator";

export declare function evaluateSessionAccess(
    accessClass: SessionAccessClass,
    snapshot: SessionAccessSnapshot | null,
    opts?: { isAdmin?: boolean; systemReadable?: boolean; adminScope?: AdminScope },
): SessionAccessDecision;

/** Archive reads are owner-or-admin ONLY — never a share. See proposal §15 A3. */
export declare function evaluateArchiveAccess(
    snapshot: SessionAccessSnapshot | null,
    opts?: { isAdmin?: boolean; adminScope?: AdminScope },
): SessionAccessDecision;

/** A sign-in role observation read from the users table. */
export interface RoleObservation {
    role?: string | null;
    seenAt?: Date | null;
}

/** How old a recorded sign-in role may be and still confer privilege. */
export declare const ROLE_OBSERVATION_MAX_AGE_MS: number;

/**
 * Does a recorded sign-in role still make this principal an administrator?
 * Every unknown resolves to `false`.
 */
export declare function evaluateRoleObservation(
    observation: RoleObservation | null,
    opts?: { now?: number; maxAgeMs?: number; principal?: { provider?: string; subject?: string } | null },
): { isAdmin: boolean; reason?: string };
