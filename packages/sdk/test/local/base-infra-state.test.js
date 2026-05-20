/**
 * Base infrastructure state tests.
 *
 * Covers additive CMS state for groups, summaries, and child outcomes without
 * requiring an LLM turn.
 *
 * Run: npx vitest run test/local/base-infra-state.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testCatalogGroupsSummariesAndInheritance(env) {
    const catalog = await createCatalog(env);
    try {
        const groupId = `group-${env.runId}`;
        const parentId = `parent-${env.runId}`;
        const childId = `child-${env.runId}`;

        await catalog.createSessionGroup({
            groupId,
            title: "Release validation",
            metadata: { source: "test" },
        });
        await catalog.createSession(parentId, { model: "test-model", groupId });
        await catalog.createSession(childId, { parentSessionId: parentId });

        const parent = await catalog.getSession(parentId);
        const child = await catalog.getSession(childId);
        assertNotNull(parent, "Parent session should exist");
        assertNotNull(child, "Child session should exist");
        assertEqual(parent.groupId, groupId, "Parent should keep explicit groupId");
        assertEqual(child.groupId, groupId, "Child should inherit parent groupId");

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

        const groups = await catalog.listSessionGroups();
        const group = groups.find((item) => item.groupId === groupId);
        assertNotNull(group, "Group should be listed");
        assertEqual(group.memberCount, 2, "Group should include parent and inherited child");
        assert(group.latestSummaryUpdatedAt instanceof Date, "Group should expose latest summary timestamp");

        const groupSessions = await catalog.listGroupSessions(groupId);
        assertEqual(groupSessions.length, 2, "Group sessions should list both members");

        const deleteBeforeMembers = await catalog.deleteSessionGroup(groupId);
        assertEqual(deleteBeforeMembers, false, "Group delete should wait for member deletion");

        await catalog.softDeleteSession(childId);
        await catalog.softDeleteSession(parentId);
        const deleteAfterMembers = await catalog.deleteSessionGroup(groupId);
        assertEqual(deleteAfterMembers, true, "Group delete should succeed after members are gone");
    } finally {
        await catalog.close();
    }
}

async function testManagementGroupAndSummaryReadApis(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    try {
        const sessionId = `managed-${env.runId}`;
        await catalog.createSession(sessionId, { model: "test-model" });

        const group = await mgmt.createSessionGroup({
            groupId: `mgmt-group-${env.runId}`,
            title: "Managed Group",
            metadata: { mode: "initial" },
        });
        assertEqual(group.title, "Managed Group", "Management group title should persist");

        await catalog.createSession(`member-${env.runId}`, { groupId: group.groupId });
        const updated = await mgmt.updateSessionGroup(group.groupId, {
            title: "Managed Group Updated",
            metadataPatch: { mode: "updated" },
        });
        assertEqual(updated.title, "Managed Group Updated", "Management group update should persist");
        assertEqual(updated.metadata.mode, "updated", "Metadata patch should merge");

        const assignedId = `assigned-${env.runId}`;
        await catalog.createSession(assignedId);
        await mgmt.moveSessionsToGroup(group.groupId, [assignedId]);

        const groupSessions = await mgmt.listGroupSessions(group.groupId);
        assertEqual(groupSessions.length, 2, "Management group sessions should use CMS group membership");
        assertEqual(groupSessions.every((session) => session.groupId === group.groupId), true, "Management session views should include groupId");

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

        let deleteFailed = false;
        try {
            await mgmt.deleteSessionGroup(group.groupId);
        } catch {
            deleteFailed = true;
        }
        assertEqual(deleteFailed, true, "Management group delete should fail while members remain");

        await mgmt.moveSessionsToGroup(null, [`member-${env.runId}`, assignedId]);
        await mgmt.deleteSessionGroup(group.groupId);
        const memberAfterDelete = await catalog.getSession(`member-${env.runId}`);
        assertNotNull(memberAfterDelete, "Management group delete should not delete member sessions");
        assertEqual(memberAfterDelete.groupId, null, "Moved-out member should no longer belong to the group");
        const remainingGroups = await mgmt.listSessionGroups();
        assert(!remainingGroups.some((item) => item.groupId === group.groupId), "Empty group should be deleted");
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
        const movedA = await catalog.getSession(ownedA);
        assertEqual(movedA?.groupId, group.groupId, "Same-owner session should move into group");

        await assertThrows(
            () => mgmt.moveSessionsToGroup(group.groupId, [ownedB]),
            /owner does not match|owned by/i,
            "Management move should reject different-owner sessions",
        );
        const rejectedB = await catalog.getSession(ownedB);
        assertEqual(rejectedB?.groupId, null, "Different-owner session should not be moved");

        await assertThrows(
            () => catalog.createSession(`bad-create-${env.runId}`, { owner: ownerB, groupId: group.groupId }),
            /owner does not match/i,
            "Catalog create should reject different-owner group assignment",
        );
        const badCreate = await catalog.getSession(`bad-create-${env.runId}`);
        assertEqual(badCreate, null, "Rejected grouped create should roll back the session row");

        const adoptGroup = await mgmt.createSessionGroup({
            groupId: `adopt-group-${env.runId}`,
            title: "Adopt Owner Group",
        });
        assertEqual(adoptGroup.owner, null, "Unowned group should start without an owner");
        const adoptSession = `adopt-session-${env.runId}`;
        await catalog.createSession(adoptSession, { owner: ownerA });

        await mgmt.moveSessionsToGroup(adoptGroup.groupId, [adoptSession]);

        const adoptedSession = await catalog.getSession(adoptSession);
        assertEqual(adoptedSession?.groupId, adoptGroup.groupId, "Owned session should move into empty unowned group");
        const adoptedGroup = (await mgmt.listSessionGroups()).find((candidate) => candidate.groupId === adoptGroup.groupId);
        assertEqual(adoptedGroup?.owner?.subject, ownerA.subject, "Empty unowned group should adopt the moved session owner");
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

    it("Enforces matching owners for session group membership", { timeout: TIMEOUT }, async () => {
        await testGroupOwnerEnforcement(getEnv());
    });

    it("Child outcome upserts", { timeout: TIMEOUT }, async () => {
        await testChildOutcomeUpserts(getEnv());
    });

});
