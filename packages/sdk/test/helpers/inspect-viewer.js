/**
 * A resolved viewer for tests that build inspect tools directly.
 *
 * Phase A made `createInspectTools` viewer-driven: every session-touching
 * tool resolves a principal from the session OWNER and refuses when it cannot.
 * Omitting `resolveViewer` therefore yields NO_VIEWER, and NO_VIEWER is
 * deliberately useless — lists come back empty and direct reads return
 * `{ error }`.
 *
 * That default is correct for production (a caller who forgets to pass a
 * viewer gets a useless agent, not a fleet-wide reader), but it means a test
 * that builds tools directly has to say who it is acting as, or it is
 * asserting against refusals rather than behaviour.
 */

/** Acts as an administrator — the widest reach, for tests about tool WIRING. */
export const TEST_ADMIN_VIEWER = () => ({
    provider: "test",
    subject: "inspect-admin",
    isAdmin: true,
    isSystemPrincipal: false,
});

/** Acts as an ordinary user — for tests about SCOPING and refusal. */
export const testUserViewer = (subject = "inspect-user") => () => ({
    provider: "test",
    subject,
    isAdmin: false,
    isSystemPrincipal: false,
});

/**
 * Acts as the System principal, which `ensureVisible` admits without
 * consulting the catalog at all.
 *
 * For tests that exercise tool WIRING with synthetic session ids — "does this
 * tool normalize its argument", "is it registered only when a duroxide client
 * is present". Those ids do not exist in any catalog, so an ordinary or admin
 * viewer would refuse them as NOT FOUND and the test would be asserting
 * against a refusal instead of the behaviour it names.
 *
 * Use `TEST_ADMIN_VIEWER` whenever the session ids are real.
 */
export const TEST_SYSTEM_VIEWER = () => ({
    provider: "system",
    subject: "system",
    isAdmin: false,
    isSystemPrincipal: true,
});
