/**
 * `evaluateRoleObservation` — does a recorded sign-in role still make this
 * principal an administrator?
 *
 * This is the predicate that closed the design's open gap: the worker had no
 * way to know an owner's role, so `isAdmin` was hard-coded `false` and the
 * admin row of the authz matrix was not real. The portal now records the role
 * it authenticated with (migration 0042) and the worker reads that
 * observation through this function.
 *
 * Everything here is about the OBSERVATION being evidence rather than fact.
 * The authority is the identity provider; this is only the most recent thing
 * it said. So every case below asks the same question in a different way:
 * when the evidence is missing, malformed, or old, does this fail CLOSED?
 *
 * Validated by breakage (§16.5): each assertion was confirmed to go red
 * against a deliberately-weakened predicate before being kept.
 *
 * Run: node --test test/unit/role-observation.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    evaluateRoleObservation,
    ROLE_OBSERVATION_MAX_AGE_MS,
} from "../../api/src/session-authz.js";

const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);
const NO_AUTH = { provider: "none", subject: "unknown" };
const NAMED = { provider: "entra", subject: "alice" };
const agoMs = (ms) => new Date(NOW - ms);
const at = (observation, principal = NAMED) => evaluateRoleObservation(observation, { now: NOW, principal });

// ── The privileged cases, which must actually work ────────────────

test("a fresh admin observation confers admin", () => {
    assert.equal(at({ role: "admin", seenAt: agoMs(60_000) }).isAdmin, true);
});

test("anonymous confers admin — an auth-disabled deployment is trusted", () => {
    // The portal already grants full access to `anonymous`
    // (isAdmin = role === "admin" || role === "anonymous"). A worker that
    // disagreed would make agents quietly more restricted than the UI they
    // sit next to, which is the opposite of the "match the UI" rule the rest
    // of the viewer spine follows.
    assert.equal(at({ role: "anonymous", seenAt: agoMs(1000) }, NO_AUTH).isAdmin, true);
});

test("anonymous is bound to the auth-disabled principal — A10, names never GRANT", () => {
    // `anonymous` is a NAME trusted to grant fleet-wide reach. Today nothing
    // can write it for a named user (authorizePrincipal only issues it in the
    // no-principal branch, which pairs it with `none:unknown`). This makes
    // that a property of THIS function rather than of three other files
    // staying the way they are.
    const observation = { role: "anonymous", seenAt: agoMs(1000) };
    for (const principal of [NAMED, { provider: "none", subject: "alice" }, { provider: "entra", subject: "unknown" }, null]) {
        const decision = at(observation, principal);
        assert.equal(decision.isAdmin, false, `principal ${JSON.stringify(principal)}`);
        assert.match(decision.reason, /auth-disabled principal/);
    }
});

test("an observation right at the ceiling is still believed", () => {
    assert.equal(at({ role: "admin", seenAt: agoMs(ROLE_OBSERVATION_MAX_AGE_MS) }).isAdmin, true);
});

// ── Fail closed: the whole point ──────────────────────────────────

test("a plain user is not an admin", () => {
    assert.equal(at({ role: "user", seenAt: agoMs(1000) }).isAdmin, false);
});

test("no recorded role is not an admin", () => {
    for (const observation of [null, undefined, {}, { role: null, seenAt: null }]) {
        assert.equal(at(observation).isAdmin, false, `observation ${JSON.stringify(observation)}`);
    }
});

test("an unrecognized role is not an admin", () => {
    // The stored vocabulary is closed. Anything else — a role invented by a
    // future provider, a typo, an injected string — must read as no
    // privilege rather than be compared loosely by some later caller.
    for (const role of ["superadmin", "Administrator", "owner", "root", "admin,user", "ADMIN\u0000"]) {
        assert.equal(at({ role, seenAt: agoMs(1000) }).isAdmin, false, `role ${JSON.stringify(role)}`);
    }
});

test("an admin role with no observation timestamp is not an admin", () => {
    // A row written before the column existed, or by a caller that skipped
    // the stamp. Un-dateable evidence cannot be checked for staleness, so it
    // cannot be trusted.
    assert.equal(at({ role: "admin", seenAt: null }).isAdmin, false);
});

test("a stale admin observation expires", () => {
    const decision = at({ role: "admin", seenAt: agoMs(ROLE_OBSERVATION_MAX_AGE_MS + 1000) });
    assert.equal(decision.isAdmin, false);
    assert.match(decision.reason, /stale/, "the refusal must say why, not just refuse");
});

test("the concrete scenario the ceiling exists for", () => {
    // An admin is demoted in the identity provider and never opens the portal
    // again, while a cron-driven session of theirs keeps firing turns. Nothing
    // will ever contradict the stored `admin`; only its age can.
    const lastSignIn = agoMs(3 * 24 * 60 * 60 * 1000); // three days
    assert.equal(at({ role: "admin", seenAt: lastSignIn }).isAdmin, false);
});

// ── Shapes that must not be coerced into privilege ────────────────

test("a non-Date timestamp is refused rather than parsed", () => {
    // If an observation ever crosses a JSON boundary its Date becomes a
    // string. Widening a PRIVILEGE check to accept more shapes is the wrong
    // direction; refusing is both safe and loud.
    for (const seenAt of [new Date(NOW).toISOString(), NOW, "yesterday", {}, new Date("nope")]) {
        assert.equal(at({ role: "admin", seenAt }).isAdmin, false, `seenAt ${JSON.stringify(seenAt)}`);
    }
});

test("clock skew cannot extend the window", () => {
    // A worker whose clock lags the portal sees a future timestamp. That is
    // believable (it is fresher than now), but it must not be a way to make
    // an observation immortal — which is why the check is on elapsed age
    // against the ceiling and not on an absolute expiry the writer controls.
    assert.equal(at({ role: "admin", seenAt: new Date(NOW + 60_000) }).isAdmin, true);
    // The ceiling still governs once real time passes.
    assert.equal(
        evaluateRoleObservation(
            { role: "admin", seenAt: new Date(NOW + 60_000) },
            { now: NOW + 60_000 + ROLE_OBSERVATION_MAX_AGE_MS + 1000 },
        ).isAdmin,
        false,
    );
});

test("the ceiling is a real bound, not an accident of a huge default", () => {
    // Guards against someone "fixing" a flaky test by setting the ceiling to
    // Infinity, which would silently restore the unbounded-staleness hole.
    assert.ok(Number.isFinite(ROLE_OBSERVATION_MAX_AGE_MS));
    assert.ok(
        ROLE_OBSERVATION_MAX_AGE_MS <= 7 * 24 * 60 * 60 * 1000,
        "a role observation older than a week is not evidence of current privilege",
    );
});
