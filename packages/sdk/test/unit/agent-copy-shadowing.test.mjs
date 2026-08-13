/**
 * Per-session agent-copy resolution — the worker-side half of scope shadowing.
 *
 * One agent NAME can be served by several enabled packages at once (a shared
 * copy plus per-user copies). Sessions must resolve their OWNER's copy — the
 * same "own copy shadows shared" rule the registry applies — and never
 * whichever copy happened to load last. These are the pure helpers the
 * session-manager builds that pick on; the load-order bug they replace served
 * one user's private prompt to the whole fleet.
 *
 * Run: node --test test/unit/agent-copy-shadowing.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    agentOwnerKey,
    packageAgentKey,
    pickAgentCopyForOwner,
} from "../../dist/session-manager.js";
import { resolveAgentDefinitionForCaller } from "../../dist/session-proxy.js";

const ALICE = { provider: "test", subject: "alice" };
const BOB = { provider: "test", subject: "bob" };

const sharedCopy = {
    prompt: "SHARED PROMPT",
    kind: "app-agent",
    packageId: "pkg-shared",
    packageScope: "shared",
    packageOwner: null,
};
const aliceCopy = {
    prompt: "ALICE PROMPT",
    kind: "app-agent",
    packageId: "pkg-alice",
    packageScope: "user",
    packageOwner: ALICE,
};
const entry = { ...sharedCopy, copies: [sharedCopy, aliceCopy] };

test("owner key requires both halves and is separator-safe", () => {
    assert.equal(agentOwnerKey(null), null);
    assert.equal(agentOwnerKey({ provider: "p" }), null);
    assert.equal(agentOwnerKey(ALICE), `test\u0001alice`);
    // \u0001 cannot appear in legitimate provider/subject values, so two
    // different identities can never collapse to one key.
    assert.notEqual(agentOwnerKey({ provider: "test", subject: "a" }), agentOwnerKey({ provider: "tes", subject: "ta" }));
});

test("packageAgentKey cannot collide with a bare agent name", () => {
    const key = packageAgentKey("pkg-1", "helper");
    assert.ok(key.includes("\u0001"));
    assert.notEqual(key, "helper");
});

test("the owner gets their own copy; everyone else gets the shared default", () => {
    assert.equal(pickAgentCopyForOwner(entry, agentOwnerKey(ALICE))?.prompt, "ALICE PROMPT");
    assert.equal(pickAgentCopyForOwner(entry, agentOwnerKey(BOB))?.prompt, "SHARED PROMPT");
    assert.equal(pickAgentCopyForOwner(entry, null)?.prompt, "SHARED PROMPT");
});

test("a deployment or shared entry with no copies list is returned as-is", () => {
    const deployment = { prompt: "ONLY", kind: "app-agent" }; // no packageScope
    assert.equal(pickAgentCopyForOwner(deployment, agentOwnerKey(ALICE)), deployment);
    const shared = { prompt: "S", kind: "app-agent", packageId: "p", packageScope: "shared" };
    assert.equal(pickAgentCopyForOwner(shared, agentOwnerKey(BOB)), shared);
    assert.equal(pickAgentCopyForOwner(undefined, agentOwnerKey(ALICE)), undefined);
});

// ── FAIL CLOSED: a foreign private copy is never served ───────────────
// Regression for the round-1 critical: when a private user-scope copy is the
// only copy of a name (or the default), it must NOT be handed to another
// owner's session — prompt, MCP, and tool handlers all follow this pick.

test("a lone foreign private copy is refused (undefined), not served as the default", () => {
    const onlyAlice = { prompt: "ALICE", kind: "app-agent", packageId: "pa", packageScope: "user", packageOwner: ALICE };
    // Bob (or an unresolvable/null owner) gets nothing — never Alice's copy.
    assert.equal(pickAgentCopyForOwner(onlyAlice, agentOwnerKey(BOB)), undefined);
    assert.equal(pickAgentCopyForOwner(onlyAlice, null), undefined);
    // Alice still gets her own.
    assert.equal(pickAgentCopyForOwner(onlyAlice, agentOwnerKey(ALICE))?.prompt, "ALICE");
});

test("with only private copies and no owner match, resolution fails closed", () => {
    const carol = { provider: "test", subject: "carol" };
    const aliceC = { prompt: "A", kind: "app-agent", packageId: "pa", packageScope: "user", packageOwner: ALICE };
    const carolC = { prompt: "C", kind: "app-agent", packageId: "pc", packageScope: "user", packageOwner: carol };
    const twoPrivate = { ...aliceC, copies: [aliceC, carolC] };
    assert.equal(pickAgentCopyForOwner(twoPrivate, agentOwnerKey(BOB)), undefined);
    assert.equal(pickAgentCopyForOwner(twoPrivate, agentOwnerKey(ALICE))?.prompt, "A");
    assert.equal(pickAgentCopyForOwner(twoPrivate, agentOwnerKey(carol))?.prompt, "C");
});

test("a shared copy is always preferred over any private copy for a non-owner", () => {
    const sharedC = { prompt: "SHARED", kind: "app-agent", packageId: "ps", packageScope: "shared", packageOwner: null };
    const aliceC = { prompt: "ALICE", kind: "app-agent", packageId: "pa", packageScope: "user", packageOwner: ALICE };
    // copies listed private-first to prove order does not matter.
    const mixed = { ...aliceC, copies: [aliceC, sharedC] };
    assert.equal(pickAgentCopyForOwner(mixed, agentOwnerKey(BOB))?.prompt, "SHARED");
});

test("a deployment copy outranks a shared package regardless of copies[] order", () => {
    // Insertion order shared-first: rank, not order, must win. A deployment
    // copy has no packageScope; the worker default is the deployment copy, so
    // the per-session pick must agree or the two disagree about the default.
    const deployC = { prompt: "DEPLOY", kind: "app-agent" }; // no packageId/scope
    const sharedC = { prompt: "SHARED", kind: "app-agent", packageId: "ps", packageScope: "shared", packageOwner: null };
    const entry = { ...sharedC, copies: [sharedC, deployC] };
    assert.equal(pickAgentCopyForOwner(entry, agentOwnerKey(BOB))?.prompt, "DEPLOY");
    // The deployment copy has no packageId → the session reads the BARE MCP
    // key, so a deployment agent that shares a name with a package keeps its
    // own MCP servers (the round-2 regression this guards).
    assert.equal(pickAgentCopyForOwner(entry, agentOwnerKey(BOB))?.packageId, undefined);
});

// ── The one shared name resolver (spawn/create + activity) ────────────

const loadedAgents = [
    { name: "analyst", prompt: "SHARED PROMPT", packageId: "pkg-shared", packageScope: "shared" },
    { name: "analyst", prompt: "ALICE PROMPT", packageId: "pkg-alice", packageScope: "user", packageOwner: ALICE },
    { name: "plain", prompt: "PLAIN PROMPT" },
];

test("bare name: caller's own copy shadows shared; strangers get shared", async () => {
    const asAlice = await resolveAgentDefinitionForCaller({
        agentName: "analyst",
        userAgents: loadedAgents,
        getCallerOwnerKey: async () => agentOwnerKey(ALICE),
    });
    assert.equal(asAlice?.prompt, "ALICE PROMPT");
    assert.equal(asAlice?.packageId, "pkg-alice");

    const asBob = await resolveAgentDefinitionForCaller({
        agentName: "analyst",
        userAgents: loadedAgents,
        getCallerOwnerKey: async () => agentOwnerKey(BOB),
    });
    assert.equal(asBob?.prompt, "SHARED PROMPT");
    assert.equal(asBob?.packageId, "pkg-shared");
});

test("__shared: explicitly reaches past the caller's own copy", async () => {
    const def = await resolveAgentDefinitionForCaller({
        agentName: "__shared:analyst",
        userAgents: loadedAgents,
        getCallerOwnerKey: async () => agentOwnerKey(ALICE),
    });
    assert.equal(def?.prompt, "SHARED PROMPT");
});

test("a private copy is invisible to strangers when it is the only copy", async () => {
    const onlyPrivate = [{ name: "secret", prompt: "PRIVATE", packageId: "p", packageScope: "user", packageOwner: ALICE }];
    const asBob = await resolveAgentDefinitionForCaller({
        agentName: "secret",
        userAgents: onlyPrivate,
        getCallerOwnerKey: async () => agentOwnerKey(BOB),
    });
    assert.equal(asBob, null);
    const asAlice = await resolveAgentDefinitionForCaller({
        agentName: "secret",
        userAgents: onlyPrivate,
        getCallerOwnerKey: async () => agentOwnerKey(ALICE),
    });
    assert.equal(asAlice?.prompt, "PRIVATE");
});

test("an unresolvable caller fails closed: no private agents", async () => {
    const onlyPrivate = [{ name: "secret", prompt: "PRIVATE", packageId: "p", packageScope: "user", packageOwner: ALICE }];
    const def = await resolveAgentDefinitionForCaller({
        agentName: "secret",
        userAgents: onlyPrivate,
        getCallerOwnerKey: async () => { throw new Error("catalog down"); },
    });
    assert.equal(def, null);
});
