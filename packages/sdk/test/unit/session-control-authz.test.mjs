/**
 * Who may drive or end a session.
 *
 * The gate on `message_agent_session` (type into a session as its user) and
 * `manage_agent_session` (complete / cancel / delete). Owner-or-admin, and
 * lifecycle operations refuse system sessions for EVERY principal.
 *
 * Deliberately narrower than "can read": visibility includes sessions shared
 * WITH you, and being allowed to watch a run is not being allowed to end it.
 *
 * Run: node --test test/unit/session-control-authz.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideSessionControl } from "../../dist/agent-manager-tools.js";

const ALICE = { provider: "entra", subject: "alice" };
const BOB = { provider: "entra", subject: "bob" };

const sessionOf = (owner, extra = {}) => ({ owner, ...extra });
const decide = (over = {}) => decideSessionControl({
    target: sessionOf(ALICE),
    targetIdLabel: "abcd1234",
    caller: ALICE,
    callerIsAdmin: false,
    ...over,
});

// ── the allow cases ──────────────────────────────────────────────

test("the owner may act on their own session", () => {
    assert.deepEqual(decide(), { ok: true });
});

test("an admin may act on someone else's session", () => {
    assert.deepEqual(decide({ caller: BOB, callerIsAdmin: true }), { ok: true });
});

// ── the refusals ─────────────────────────────────────────────────

test("a non-owner without admin is refused", () => {
    const v = decide({ caller: BOB });
    assert.equal(v.ok, false);
    assert.match(v.reason, /neither own session abcd1234 nor hold the admin role/);
});

test("a missing session is refused, not treated as ownerless-and-free", () => {
    const v = decide({ target: null });
    assert.equal(v.ok, false);
    assert.match(v.reason, /not found/);
});

test("an unidentifiable caller drives nothing — fail closed", () => {
    for (const caller of [null, {}, { provider: "entra" }, { subject: "alice" }]) {
        const v = decide({ caller });
        assert.equal(v.ok, false, `caller ${JSON.stringify(caller)} must be refused`);
        assert.match(v.reason, /could not be identified/);
    }
});

test("an ownerless session is not free real estate for a non-admin", () => {
    const v = decide({ target: sessionOf(null), caller: BOB });
    assert.equal(v.ok, false);
    // An admin still may — that is the fleet-wide capability, not a hole.
    assert.deepEqual(decide({ target: sessionOf(null), caller: BOB, callerIsAdmin: true }), { ok: true });
});

test("owner match is on BOTH provider and subject", () => {
    // Same subject under a different provider is a different person.
    const v = decide({ target: sessionOf({ provider: "github", subject: "alice" }), caller: ALICE });
    assert.equal(v.ok, false);
});

// ── system sessions ──────────────────────────────────────────────

test("a system session is refused for lifecycle even to an ADMIN", () => {
    const v = decideSessionControl({
        target: sessionOf(ALICE, { isSystem: true }),
        targetIdLabel: "sys00001",
        caller: BOB,
        callerIsAdmin: true,
        refuseSystem: true,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /system session/);
});

test("a system session is refused for lifecycle even to its OWNER", () => {
    const v = decideSessionControl({
        target: sessionOf(ALICE, { isSystem: true }),
        targetIdLabel: "sys00001",
        caller: ALICE,
        callerIsAdmin: false,
        refuseSystem: true,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /system session/);
});

test("the system refusal is checked BEFORE admin, so admin cannot reach past it", () => {
    // Ordering matters: if admin were evaluated first, an admin would be able
    // to delete the sweeper.
    const v = decideSessionControl({
        target: sessionOf(null, { isSystem: true }),
        targetIdLabel: "sys00001",
        caller: BOB,
        callerIsAdmin: true,
        refuseSystem: true,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /system session/);
});

test("without refuseSystem, messaging a system session is not blocked by THIS rule", () => {
    // message_agent_session does not pass refuseSystem; the owner/admin rule
    // still applies, which is what keeps it safe.
    assert.deepEqual(
        decideSessionControl({
            target: sessionOf(ALICE, { isSystem: true }),
            targetIdLabel: "sys00001",
            caller: ALICE,
            callerIsAdmin: false,
        }),
        { ok: true },
    );
});
