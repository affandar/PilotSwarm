import test from "node:test";
import assert from "node:assert/strict";
import {
    isOwnerScopedRoutingTag,
    ownerAffinityKey,
    repoFromRoutingTag,
    requireWorkerRoutingTag,
    runTurnRoutingTag,
    scopeWorkerTagFilter,
    workerOwnerFromEnv,
} from "../../dist/activity-routing.js";

const alice = { provider: "dev", subject: "alice" };
const bob = { provider: "dev", subject: "bob" };

test("owner affinity composes with repo routing without exposing the subject", () => {
    const tag = runTurnRoutingTag({ repo: "sample-repo", ownerAffinity: alice });
    assert.match(tag, /^owner:v1:[0-9a-f]{32}\|repo:sample-repo$/);
    assert.equal(tag.includes("alice"), false);
    assert.equal(isOwnerScopedRoutingTag(tag), true);
    assert.equal(isOwnerScopedRoutingTag("repo:sample-repo"), false);
    assert.equal(repoFromRoutingTag(tag), "sample-repo");
    assert.notEqual(ownerAffinityKey(alice), ownerAffinityKey(bob));
});

test("unowned sessions retain legacy repo and generic routing", () => {
    assert.equal(runTurnRoutingTag({ repo: "sample-repo" }), "repo:sample-repo");
    assert.equal(runTurnRoutingTag({}), "generic");
    assert.equal(repoFromRoutingTag("gpu|repo:sample-repo"), null);
});

test("personal workers advertise the same composite repo and generic tags", () => {
    const filter = scopeWorkerTagFilter(
        { defaultAnd: ["repo:sample-repo", "generic"] },
        alice,
    );
    assert.deepEqual(filter, {
        defaultAnd: [
            runTurnRoutingTag({ repo: "sample-repo", ownerAffinity: alice }),
            runTurnRoutingTag({ ownerAffinity: alice }),
        ],
    });
});

test("required capability tags compose with repo filters without changing their mode", () => {
    assert.deepEqual(
        requireWorkerRoutingTag({ defaultAnd: ["repo:sample-repo"] }, "handoff"),
        { defaultAnd: ["repo:sample-repo", "handoff"] },
    );
    assert.deepEqual(
        requireWorkerRoutingTag({ tags: ["gpu"] }, "handoff"),
        { tags: ["gpu", "handoff"] },
    );
    assert.deepEqual(
        requireWorkerRoutingTag(undefined, "handoff"),
        { defaultAnd: ["handoff"] },
    );
    assert.equal(requireWorkerRoutingTag("none", "handoff"), "none");
});

test("personal workers reject unrestricted or mismatched owner routing", () => {
    assert.throws(
        () => scopeWorkerTagFilter("any", alice),
        /cannot use workerTagFilter "any"/,
    );
    assert.throws(
        () => scopeWorkerTagFilter(
            { defaultAnd: [runTurnRoutingTag({ repo: "sample-repo", ownerAffinity: bob })] },
            alice,
        ),
        /does not match workerOwner/,
    );
});

test("unowned workers cannot opt out of owner-affinity isolation", () => {
    assert.throws(
        () => scopeWorkerTagFilter("any", undefined),
        /cannot use workerTagFilter "any"/,
    );
    assert.throws(
        () => scopeWorkerTagFilter(
            { defaultAnd: [runTurnRoutingTag({ repo: "sample-repo", ownerAffinity: alice })] },
            undefined,
        ),
        /require workerOwner/,
    );
});

test("worker owner environment configuration is all-or-nothing", () => {
    assert.equal(workerOwnerFromEnv({}), undefined);
    assert.deepEqual(workerOwnerFromEnv({
        PILOTSWARM_WORKER_OWNER_PROVIDER: " DEV ",
        PILOTSWARM_WORKER_OWNER_SUBJECT: " alice ",
    }), alice);
    assert.throws(
        () => workerOwnerFromEnv({ PILOTSWARM_WORKER_OWNER_PROVIDER: "dev" }),
        /must be set together/,
    );
});
