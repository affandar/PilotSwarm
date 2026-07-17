/**
 * Base infrastructure state tests.
 *
 * Covers additive CMS state for groups (private per-user placements as of
 * migration 0034), summaries, and child outcomes without requiring an LLM
 * turn.
 *
 * Run: npx vitest run test/local/base-infra-state.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testCatalogGroupsSummariesAndInheritance(env) {
    const catalog = await createCatalog(env);
    try {
        const owner = {
            provider: "test",
            subject: `catalog-owner-${env.runId}`,
            email: `catalog-owner-${env.runId}@example.com`,
            displayName: "Catalog Owner",
        };
        const viewer = { provider: owner.provider, subject: owner.subject };
        const groupId = `group-${env.runId}`;
        const parentId = `parent-${env.runId}`;
        const childId = `child-${env.runId}`;

        await catalog.createSessionGroup({
            groupId,
            title: "Release validation",
            owner,
            metadata: { source: "test" },
        });
        await catalog.createSession(parentId, { model: "test-model", groupId, owner });
        await catalog.createSession(childId, { parentSessionId: parentId });

        const parent = await catalog.getSession(parentId, viewer);
        const child = await catalog.getSession(childId, viewer);
        assertNotNull(parent, "Parent session should exist");
        assertNotNull(child, "Child session should exist");
        assertEqual(parent.groupId, groupId, "Owned create should place the root in the same transaction");
        assertEqual(child.groupId, null, "Children are never placed; membership rides the root");

        const parentWithoutViewer = await catalog.getSession(parentId);
        assertEqual(parentWithoutViewer.groupId, null, "Reads without a placement viewer should not see a group");

        const ownerlessId = `ownerless-${env.runId}`;
        await catalog.createSession(ownerlessId, { model: "test-model", groupId });
        const ownerless = await catalog.getSession(ownerlessId, viewer);
        assertNotNull(ownerless, "Ownerless grouped create should still create the session");
        assertEqual(ownerless.groupId, null, "Ownerless create has no creator to place for, so no placement");

        const summaryState = {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            intent: "Validate release train",
            summary: "Waiting on smoke validation.",
            state: { cmsState: "idle" },
            openQuestions: [],
            blockers: [],
            nextActions: ["Run smoke"],
            links: [],
            structureChangeLog: [],
        };
        await catalog.updateSessionSummary(parentId, summaryState, "Smoke pending");

        const summarized = await catalog.getSession(parentId);
        assertNotNull(summarized, "Summarized session should exist");
        assertEqual(summarized.shortSummary, "Smoke pending", "Short summary should persist");
        assertEqual(summarized.summaryState.intent, "Validate release train", "Summary intent should persist");
        assert(summarized.summaryUpdatedAt instanceof Date, "summaryUpdatedAt should be a Date");

        const groups = await catalog.listSessionGroups(viewer);
        const group = groups.find((item) => item.groupId === groupId);
        assertNotNull(group, "Group should be listed for its owner");
        assertEqual(group.memberCount, 1, "Group should count the placed root once");
        assert(group.latestSummaryUpdatedAt instanceof Date, "Group should expose latest summary timestamp");

        const groupSessions = await catalog.listGroupSessions(groupId, viewer);
        assertEqual(groupSessions.length, 2, "Group sessions should list the placed root and its child");
        assertEqual(groupSessions.find((row) => row.sessionId === parentId)?.groupId, groupId, "Root row should carry the placement group");
        assertEqual(groupSessions.find((row) => row.sessionId === childId)?.groupId, null, "Child row should not carry a placement");

        const deleteWithPlacements = await catalog.deleteSessionGroup(groupId);
        assertEqual(deleteWithPlacements, true, "Group delete should succeed while placements remain");
        const parentAfterDelete = await catalog.getSession(parentId, viewer);
        assertNotNull(parentAfterDelete, "Group delete should never delete sessions");
        assertEqual(parentAfterDelete.groupId, null, "Group delete should cascade the owner's placements");
        const deleteMissing = await catalog.deleteSessionGroup(groupId);
        assertEqual(deleteMissing, false, "Deleting a missing group should report false");
    } finally {
        await catalog.close();
    }
}

async function testManagementGroupAndSummaryReadApis(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    const owner = {
        provider: "test",
        subject: `mgmt-owner-${env.runId}`,
        email: `mgmt-owner-${env.runId}@example.com`,
        displayName: "Mgmt Owner",
    };
    const viewer = { provider: owner.provider, subject: owner.subject };
    try {
        const sessionId = `managed-${env.runId}`;
        await catalog.createSession(sessionId, { model: "test-model" });

        const group = await mgmt.createSessionGroup({
            groupId: `mgmt-group-${env.runId}`,
            title: "Managed Group",
            owner,
            metadata: { mode: "initial" },
        });
        assertEqual(group.title, "Managed Group", "Management group title should persist");

        const memberId = `member-${env.runId}`;
        await catalog.createSession(memberId, { groupId: group.groupId, owner });
        const updated = await mgmt.updateSessionGroup(group.groupId, {
            title: "Managed Group Updated",
            metadataPatch: { mode: "updated" },
        });
        assertEqual(updated.title, "Managed Group Updated", "Management group update should persist");
        assertEqual(updated.metadata.mode, "updated", "Metadata patch should merge");

        const assignedId = `assigned-${env.runId}`;
        await catalog.createSession(assignedId, { owner });
        await mgmt.moveSessionsToGroup(group.groupId, [assignedId]);

        const groupSessions = await mgmt.listGroupSessions(group.groupId, viewer);
        assertEqual(groupSessions.length, 2, "Management group sessions should use the owner's placements");
        assertEqual(groupSessions.every((session) => session.viewerGroupId === group.groupId), true, "Management session views should carry the placement as viewerGroupId");
        assertEqual(groupSessions.every((session) => !("groupId" in session)), true, "Management session views must not emit groupId");

        const summaryState = {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            intent: "Track managed session",
            summary: "Ready for follow-up.",
            state: { cmsState: "pending" },
            openQuestions: [],
            blockers: [],
            nextActions: [],
            links: [],
            structureChangeLog: [],
        };
        await catalog.updateSessionSummary(sessionId, summaryState, "Ready for follow-up.");
        const view = await mgmt.getSession(sessionId);
        assertNotNull(view, "Management session view should exist");
        assertEqual(view.summaryState.intent, "Track managed session", "Management view should include summary state");
        assertEqual(view.shortSummary, "Ready for follow-up.", "Management view should expose short summary");
        assert(typeof view.summaryUpdatedAt === "number", "Management view should include summary timestamp");

        await mgmt.moveSessionsToGroup(null, [memberId]);
        const memberView = await mgmt.getSession(memberId, viewer);
        assertNotNull(memberView, "Moved-out member should still exist");
        assertEqual(memberView.viewerGroupId ?? null, null, "Ungrouping should clear the owner's placement");
        const assignedStillPlaced = await catalog.getSession(assignedId, viewer);
        assertEqual(assignedStillPlaced.groupId, group.groupId, "Other placements should survive an ungroup");

        await mgmt.deleteSessionGroup(group.groupId);
        const assignedAfterDelete = await catalog.getSession(assignedId, viewer);
        assertNotNull(assignedAfterDelete, "Non-empty group delete should not delete member sessions");
        assertEqual(assignedAfterDelete.groupId, null, "Group delete should cascade the owner's placements");
        const remainingGroups = await mgmt.listSessionGroups(viewer);
        assert(!remainingGroups.some((item) => item.groupId === group.groupId), "Deleted group should leave the owner's list");

        let deleteMissingFailed = false;
        try {
            await mgmt.deleteSessionGroup(group.groupId);
        } catch {
            deleteMissingFailed = true;
        }
        assertEqual(deleteMissingFailed, true, "Deleting an already-deleted group should fail");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testGroupOwnerEnforcement(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    const ownerA = {
        provider: "test",
        subject: `owner-a-${env.runId}`,
        email: `owner-a-${env.runId}@example.com`,
        displayName: "Owner A",
    };
    const ownerB = {
        provider: "test",
        subject: `owner-b-${env.runId}`,
        email: `owner-b-${env.runId}@example.com`,
        displayName: "Owner B",
    };
    const viewerA = { provider: ownerA.provider, subject: ownerA.subject };
    const viewerB = { provider: ownerB.provider, subject: ownerB.subject };
    try {
        const group = await mgmt.createSessionGroup({
            groupId: `owner-group-${env.runId}`,
            title: "Owner A Group",
            owner: ownerA,
        });
        assertEqual(group.owner?.provider, ownerA.provider, "Group owner provider should persist");
        assertEqual(group.owner?.subject, ownerA.subject, "Group owner subject should persist");
        assertEqual(group.owner?.email, ownerA.email, "Group owner email should persist");
        assertEqual(group.owner?.displayName, ownerA.displayName, "Group owner display name should persist");

        const ownedA = `owned-a-${env.runId}`;
        const ownedB = `owned-b-${env.runId}`;
        await catalog.createSession(ownedA, { owner: ownerA });
        await catalog.createSession(ownedB, { owner: ownerB });

        await mgmt.moveSessionsToGroup(group.groupId, [ownedA]);
        const movedA = await catalog.getSession(ownedA, viewerA);
        assertEqual(movedA?.groupId, group.groupId, "Move should place the session for the group owner");
        const movedAWithoutViewer = await catalog.getSession(ownedA);
        assertEqual(movedAWithoutViewer?.groupId, null, "Placements stay private to the placing viewer");

        await assertThrows(
            () => catalog.placeSessionsInGroup({ ...viewerB, isAdmin: false }, [ownedB], group.groupId),
            /not found or is not owned/i,
            "Placement should reject a target group the viewer does not own",
        );
        const rejectedB = await catalog.getSession(ownedB, viewerB);
        assertEqual(rejectedB?.groupId, null, "Rejected placement should leave the session ungrouped");

        await mgmt.moveSessionsToGroup(group.groupId, [ownedB]);
        assertEqual((await catalog.getSession(ownedB, viewerA))?.groupId, group.groupId, "Move places foreign-owned sessions as the group owner's private placement");
        assertEqual((await catalog.getSession(ownedB, viewerB))?.groupId, null, "The session owner's own view is untouched by a foreign placement");

        await assertThrows(
            () => catalog.createSession(`bad-create-${env.runId}`, { owner: ownerB, groupId: group.groupId }),
            /not found or is not owned/i,
            "Catalog create should reject a group the creator does not own",
        );
        const badCreate = await catalog.getSession(`bad-create-${env.runId}`);
        assertEqual(badCreate, null, "Rejected grouped create should roll back the session row");

        // mgmt.createSessionGroup now always stamps an owner, so a genuinely
        // ownerless group (legacy/migration data) is created via the catalog
        // directly to exercise the placement-rejection path.
        const ownerlessGroupId = `adopt-group-${env.runId}`;
        await catalog.createSessionGroup({ groupId: ownerlessGroupId, title: "Adopt Owner Group", owner: null });
        const ownerlessGroup = (await mgmt.listSessionGroups()).find((candidate) => candidate.groupId === ownerlessGroupId);
        assertEqual(ownerlessGroup?.owner ?? null, null, "Unowned group should start without an owner");
        const orphanTarget = `adopt-session-${env.runId}`;
        await catalog.createSession(orphanTarget, { owner: ownerA });

        await assertThrows(
            () => mgmt.moveSessionsToGroup(ownerlessGroup.groupId, [orphanTarget]),
            /has no owner/i,
            "Move into an ownerless group should throw instead of adopting an owner",
        );
        await assertThrows(
            () => catalog.placeSessionsInGroup({ ...viewerA, isAdmin: false }, [orphanTarget], ownerlessGroup.groupId),
            /not found or is not owned/i,
            "Direct placement into an ownerless group is structurally impossible",
        );
        assertEqual((await catalog.getSession(orphanTarget, viewerA))?.groupId, null, "Session should stay unplaced after rejected moves");
        const stillOwnerless = (await mgmt.listSessionGroups()).find((candidate) => candidate.groupId === ownerlessGroup.groupId);
        assertEqual(stillOwnerless?.owner ?? null, null, "Ownerless group should never adopt an owner");
        const viewerScoped = await catalog.listSessionGroups({ ...viewerA, isAdmin: false });
        assert(!viewerScoped.some((candidate) => candidate.groupId === ownerlessGroup.groupId), "Ownerless groups are excluded from viewer-scoped lists");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testChildOutcomeUpserts(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    try {
        const parentId = `outcome-parent-${env.runId}`;
        const childId = `outcome-child-${env.runId}`;
        await catalog.createSession(parentId);
        await catalog.createSession(childId, { parentSessionId: parentId });

        const contractJson = {
            current: {
                contractId: "contract-1",
                parentSessionId: parentId,
                childSessionId: childId,
                validationMode: "advisory",
                purpose: "Collect evidence",
            },
            revisions: [],
        };
        await catalog.upsertChildOutcome({
            childSessionId: childId,
            parentSessionId: parentId,
            contractJson,
        });

        const initial = await catalog.getChildOutcome(childId);
        assertNotNull(initial, "Child outcome should exist after contract upsert");
        assertEqual(initial.contractJson.current.contractId, "contract-1", "Contract JSON should persist");

        const resultJson = {
            current: {
                sessionId: childId,
                parentSessionId: parentId,
                verdict: "success",
                summary: "Evidence collected.",
                completedAt: new Date().toISOString(),
            },
            revisions: [],
        };
        await catalog.upsertChildOutcome({
            childSessionId: childId,
            parentSessionId: parentId,
            resultJson,
            verdict: "success",
            summary: "Evidence collected.",
            completedAt: new Date(),
        });

        const completed = await catalog.getChildOutcome(childId);
        assertNotNull(completed, "Child outcome should exist after result upsert");
        assertEqual(completed.contractJson.current.contractId, "contract-1", "Result upsert should keep existing contract JSON");
        assertEqual(completed.resultJson.current.verdict, "success", "Result JSON should persist");
        assertEqual(completed.verdict, "success", "Verdict column should persist");

        const outcomes = await catalog.listChildOutcomes(parentId);
        assertEqual(outcomes.length, 1, "Parent should list one child outcome");

        const managementOutcome = await mgmt.getChildOutcome(childId);
        assertNotNull(managementOutcome, "Management API should read child outcome");
        assertEqual(managementOutcome.summary, "Evidence collected.", "Management outcome should expose summary");
        const managementOutcomes = await mgmt.listChildOutcomes(parentId);
        assertEqual(managementOutcomes.length, 1, "Management API should list child outcomes");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

describe("Base Infrastructure State", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("CMS groups, summaries, and inheritance", { timeout: TIMEOUT }, async () => {
        await testCatalogGroupsSummariesAndInheritance(getEnv());
    });

    it("Management group and summary read APIs", { timeout: TIMEOUT }, async () => {
        await testManagementGroupAndSummaryReadApis(getEnv());
    });

    it("Enforces group ownership for session placements", { timeout: TIMEOUT }, async () => {
        await testGroupOwnerEnforcement(getEnv());
    });

    it("Child outcome upserts", { timeout: TIMEOUT }, async () => {
        await testChildOutcomeUpserts(getEnv());
    });

});
