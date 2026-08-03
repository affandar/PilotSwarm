/**
 * Fully-qualified agent/package names.
 *
 *   <package>                        bare — own enabled copy, then shared
 *   __shared:<package>[:<semver>]    the deployment-wide copy, explicitly
 *   <owner>:<package>[:<semver>]     a named owner's copy
 *
 * ── The collision this module exists to manage ──────────────────────────
 *
 * `a:b` was ALREADY meaningful before namespaces: the agent resolver reads it
 * as `namespace:agentName` (a plugin's `plugin.json` name). §9 wants the same
 * syntax to mean `owner:package`. Both readings are legitimate and neither can
 * be dropped without breaking something.
 *
 * So this parser never guesses. A two-segment name is reported as AMBIGUOUS —
 * carrying both readings — and the caller resolves in a defined order
 * (namespace first, preserving today's behaviour, then owner). Only forms that
 * are structurally unmistakable are classified outright:
 *
 *   - a `__`-prefixed first segment is a RESERVED SENTINEL, so `__shared:x`
 *     can only ever be an FQN;
 *   - three segments end in a semver, which namespaces never had.
 *
 * ── Why `__` is reserved ────────────────────────────────────────────────
 *
 * `__shared` has to be unforgeable: if a user could register the subject
 * `__shared`, or publish a package under it, they would capture every
 * unqualified reference that meant "the deployment's copy". Reserving the
 * whole prefix (not just the one token) keeps future sentinels mintable at
 * zero cost — and per §15 A10, a name may DENY but must never GRANT, which is
 * exactly how this is used: `__shared` selects a scope, it never confers rights.
 *
 * @module
 */

/** The reserved sentinel for the deployment-wide namespace. */
export const SHARED_SENTINEL = "__shared";

/** Any name starting with this is reserved for the platform. */
export const RESERVED_PREFIX = "__";

export type AgentFqnKind = "bare" | "shared" | "owner" | "ambiguous" | "invalid";

export interface AgentFqn {
    kind: AgentFqnKind;
    /** The package/agent name — always present except for `invalid`. */
    name: string;
    /** Owner segment as written, for `owner` (and the owner reading of `ambiguous`). */
    ownerRef?: string;
    /** Namespace reading of an ambiguous two-segment name. */
    namespaceRef?: string;
    /** Pinned version, when the caller named one. */
    semver?: string;
    /** Why the input was rejected. Present only for `invalid`. */
    reason?: string;
}

/**
 * Is this name reserved for the platform?
 *
 * Used at BOTH gates the design names: package publish, and user registration.
 * Checking only one of them would leave the sentinel forgeable from the other
 * side.
 */
export function isReservedName(value: string): boolean {
    return String(value ?? "").trim().toLowerCase().startsWith(RESERVED_PREFIX);
}

/**
 * A semver as this system uses it: `X.Y.Z` with optional pre-release/build.
 * Deliberately strict — the third segment of an FQN is only treated as a
 * version when it unmistakably IS one, so `a:b:c` with a non-version tail
 * stays invalid rather than silently resolving to something else.
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(value: string): boolean {
    return SEMVER_RE.test(String(value ?? "").trim());
}

const invalid = (reason: string): AgentFqn => ({ kind: "invalid", name: "", reason });

/**
 * Parse a possibly-qualified agent or package reference.
 *
 * Never throws: an unusable input comes back as `kind: "invalid"` with a
 * reason, because these strings arrive from models and users alike and a
 * parser that throws on hostile input is a denial-of-service in the turn loop.
 */
export function parseAgentFqn(raw: string): AgentFqn {
    // Reject non-strings rather than coercing. `String(123)` would parse as
    // the perfectly valid bare name "123", and `String({})` as
    // "[object Object]" — both of which hide a caller bug behind a name that
    // looks legitimate all the way down to the database.
    if (typeof raw !== "string") return invalid("name must be a string");
    const text = raw.trim();
    if (!text) return invalid("empty name");

    const parts = text.split(":");
    if (parts.some((p) => p.trim() === "")) {
        // Catches ":x", "x:", "a::b" — all of which would otherwise produce a
        // silently empty segment and resolve to something unintended.
        return invalid(`malformed qualified name "${text}": empty segment`);
    }
    if (parts.length > 3) {
        return invalid(`malformed qualified name "${text}": too many segments`);
    }

    if (parts.length === 1) {
        const name = parts[0];
        if (isReservedName(name)) {
            return invalid(`"${name}" uses the reserved "${RESERVED_PREFIX}" prefix`);
        }
        return { kind: "bare", name };
    }

    const [first, second, third] = parts;

    // A reserved first segment is unambiguous by construction.
    if (isReservedName(first)) {
        if (first.toLowerCase() !== SHARED_SENTINEL) {
            return invalid(`"${first}" is a reserved namespace and is not recognized`);
        }
        if (isReservedName(second)) {
            return invalid(`"${second}" uses the reserved "${RESERVED_PREFIX}" prefix`);
        }
        if (parts.length === 3) {
            if (!isSemver(third)) return invalid(`"${third}" is not a valid semver`);
            return { kind: "shared", name: second, semver: third };
        }
        return { kind: "shared", name: second };
    }

    if (isReservedName(second)) {
        return invalid(`"${second}" uses the reserved "${RESERVED_PREFIX}" prefix`);
    }

    // Three segments end in a semver — a shape namespaces never had, so this
    // is unambiguously an FQN.
    if (parts.length === 3) {
        if (!isSemver(third)) return invalid(`"${third}" is not a valid semver`);
        return { kind: "owner", name: second, ownerRef: first, semver: third };
    }

    // Two segments: genuinely both readings. Report both and let the resolver
    // apply its documented order rather than guessing here.
    return { kind: "ambiguous", name: second, ownerRef: first, namespaceRef: first };
}

/** Render a parsed reference back to its canonical string, for display. */
export function formatAgentFqn(fqn: AgentFqn): string {
    switch (fqn.kind) {
        case "bare":
            return fqn.name;
        case "shared":
            return `${SHARED_SENTINEL}:${fqn.name}${fqn.semver ? `:${fqn.semver}` : ""}`;
        case "owner":
        case "ambiguous":
            return `${fqn.ownerRef}:${fqn.name}${fqn.semver ? `:${fqn.semver}` : ""}`;
        default:
            return "";
    }
}
