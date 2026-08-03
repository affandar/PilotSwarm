/**
 * FQN parsing — the `__` reserved prefix, and the `a:b` ambiguity.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *  1. `__shared` must be UNFORGEABLE. If a user could register the subject
 *     `__shared`, or publish a package under it, they would capture every
 *     reference that meant "the deployment's copy". The prefix is therefore
 *     refused at both gates the design names — publish AND user registration.
 *
 *  2. `a:b` already meant `namespace:agent` before this existed. The parser
 *     must NOT silently re-read old names as `owner:package`; it reports the
 *     ambiguity and lets the resolver apply a documented order.
 *
 * Run: node --test test/unit/agent-fqn.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    parseAgentFqn, formatAgentFqn, isReservedName, isSemver,
    SHARED_SENTINEL, RESERVED_PREFIX,
} from "../../dist/agent-fqn.js";

// ── The documented forms ──────────────────────────────────────────

test("a bare name is a bare name", () => {
    assert.deepEqual(parseAgentFqn("kit-navigator"), { kind: "bare", name: "kit-navigator" });
});

test("__shared: is unambiguous, with and without a version", () => {
    assert.deepEqual(parseAgentFqn("__shared:agent-manager"), { kind: "shared", name: "agent-manager" });
    assert.deepEqual(parseAgentFqn("__shared:agent-manager:1.2.0"), {
        kind: "shared", name: "agent-manager", semver: "1.2.0",
    });
});

test("three segments are an owner FQN — a shape namespaces never had", () => {
    assert.deepEqual(parseAgentFqn("alice@example.com:kit-navigator:1.2.0"), {
        kind: "owner", name: "kit-navigator", ownerRef: "alice@example.com", semver: "1.2.0",
    });
});

test("two segments are reported AMBIGUOUS, carrying both readings", () => {
    // The whole point: `smelter:supervisor` has meant namespace:agent since
    // before FQNs existed. Re-reading it as owner:package would silently
    // repoint existing agent bindings.
    const parsed = parseAgentFqn("smelter:supervisor");
    assert.equal(parsed.kind, "ambiguous");
    assert.equal(parsed.name, "supervisor");
    assert.equal(parsed.namespaceRef, "smelter");
    assert.equal(parsed.ownerRef, "smelter");
});

// ── The reserved prefix, at both gates ────────────────────────────

test("the whole __ prefix is reserved, not just the __shared token", () => {
    assert.equal(isReservedName("__shared"), true);
    assert.equal(isReservedName("__system"), true);
    assert.equal(isReservedName("__anything"), true);
    assert.equal(isReservedName("_single"), false);
    assert.equal(isReservedName("shared"), false);
});

test("reserved names are refused wherever they appear", () => {
    // As a bare package name…
    assert.equal(parseAgentFqn("__sneaky").kind, "invalid");
    // …as the package half of an FQN…
    assert.equal(parseAgentFqn("__shared:__sneaky").kind, "invalid");
    assert.equal(parseAgentFqn("alice:__sneaky").kind, "invalid");
    // …and as an unrecognized sentinel, which must not fall through to being
    // treated as an ordinary owner name.
    const rejected = parseAgentFqn("__system:sweeper");
    assert.equal(rejected.kind, "invalid");
    assert.match(rejected.reason, /reserved/);
});

test("case does not evade the reservation", () => {
    for (const name of ["__SHARED", "__Shared:pkg", "__SYSTEM:x"]) {
        const parsed = parseAgentFqn(name);
        assert.ok(parsed.kind === "invalid" || parsed.kind === "shared", `${name} → ${parsed.kind}`);
    }
    // ...and the legitimate sentinel still parses case-insensitively.
    assert.equal(parseAgentFqn("__SHARED:pkg").kind, "shared");
});

// ── Malformed input never throws ──────────────────────────────────

test("malformed names come back invalid rather than throwing", () => {
    // These arrive from models. A parser that throws is a DoS in the turn loop.
    const bad = ["", "   ", ":", "::", ":pkg", "pkg:", "a::b", "a:b:c:d", "a:b:c:d:e"];
    for (const input of bad) {
        const parsed = parseAgentFqn(input);
        assert.equal(parsed.kind, "invalid", `${JSON.stringify(input)} → ${parsed.kind}`);
        assert.ok(parsed.reason, "an invalid parse must say why");
    }
    for (const weird of [null, undefined, 123, {}, []]) {
        assert.equal(parseAgentFqn(weird).kind, "invalid", String(weird));
    }
});

test("a three-segment name whose tail is not a semver is invalid, not guessed", () => {
    // "a:b:c" must not quietly become owner=a, package=b, version="c".
    const parsed = parseAgentFqn("alice:pkg:latest");
    assert.equal(parsed.kind, "invalid");
    assert.match(parsed.reason, /semver/);
    assert.equal(parseAgentFqn("__shared:pkg:latest").kind, "invalid");
});

test("semver recognition is strict", () => {
    for (const good of ["1.2.0", "0.0.1", "1.2.3-beta.1", "1.2.3+build5", "1.2.3-rc.1+exp"]) {
        assert.equal(isSemver(good), true, good);
    }
    for (const bad of ["1.2", "v1.2.0", "latest", "1.2.0.0", "", "1.2.x"]) {
        assert.equal(isSemver(bad), false, bad);
    }
});

// ── Round-trip ────────────────────────────────────────────────────

test("formatting round-trips every valid form", () => {
    for (const input of [
        "kit-navigator",
        `${SHARED_SENTINEL}:agent-manager`,
        `${SHARED_SENTINEL}:agent-manager:1.2.0`,
        "alice@example.com:kit-navigator:1.2.0",
        "smelter:supervisor",
    ]) {
        const parsed = parseAgentFqn(input);
        assert.notEqual(parsed.kind, "invalid", input);
        assert.equal(formatAgentFqn(parsed).toLowerCase(), input.toLowerCase(), input);
    }
});

test("whitespace is trimmed, not treated as a name", () => {
    assert.deepEqual(parseAgentFqn("  kit-navigator  "), { kind: "bare", name: "kit-navigator" });
    assert.equal(parseAgentFqn("a: b").kind, "ambiguous");
});

test("RESERVED_PREFIX is exported so other gates cannot drift from it", () => {
    // Publish and user-registration both have to check the SAME rule; a
    // second hard-coded "__" somewhere is how sentinels become forgeable.
    assert.equal(RESERVED_PREFIX, "__");
    assert.ok(SHARED_SENTINEL.startsWith(RESERVED_PREFIX));
});
