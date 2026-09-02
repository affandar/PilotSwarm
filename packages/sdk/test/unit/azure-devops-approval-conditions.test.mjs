import test from "node:test";
import assert from "node:assert/strict";
import {
    parseAzureDevOpsApprovalConditions,
    parseAzureDevOpsPullRequestApprovalTarget,
} from "../../dist/index.js";

const sourceCommit = "a".repeat(40);

function baseTarget(conditions) {
    return {
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
        expectedSourceCommit: sourceCommit,
        ...(conditions === undefined ? {} : { conditions }),
    };
}

test("omitted conditions default to a strict full approval gate", () => {
    const conditions = parseAzureDevOpsApprovalConditions(undefined);
    assert.deepEqual(conditions, {
        requiredReviewers: true,
        requireAllBlockingPolicies: true,
        requiredPolicyDisplayNames: [],
        codeReviewRecommendation: null,
    });
});

test("declared conditions default their unset fields to permissive values", () => {
    const conditions = parseAzureDevOpsApprovalConditions({
        requiredPolicyDisplayNames: ["PVS/Smart Test Selection (git)"],
        codeReviewRecommendation: ["Approve", "Approve with comments"],
    });
    assert.equal(conditions.requiredReviewers, false);
    assert.equal(conditions.requireAllBlockingPolicies, false);
    assert.deepEqual(conditions.requiredPolicyDisplayNames, [
        "PVS/Smart Test Selection (git)",
    ]);
    assert.deepEqual(conditions.codeReviewRecommendation, [
        "approve",
        "approve_with_comments",
    ]);
});

test("code-review recommendations normalize spacing, case, and hyphens", () => {
    const conditions = parseAzureDevOpsApprovalConditions({
        codeReviewRecommendation: ["  APPROVE  ", "approve-with-comments"],
    });
    assert.deepEqual(conditions.codeReviewRecommendation, [
        "approve",
        "approve_with_comments",
    ]);
});

test("an unknown code-review recommendation is rejected", () => {
    assert.throws(
        () => parseAzureDevOpsApprovalConditions({ codeReviewRecommendation: ["lgtm"] }),
        /invalid code-review recommendation/,
    );
});

test("an empty code-review recommendation array is rejected", () => {
    assert.throws(
        () => parseAzureDevOpsApprovalConditions({ codeReviewRecommendation: [] }),
        /non-empty array/,
    );
});

test("explicitly empty conditions are rejected", () => {
    assert.throws(
        () => parseAzureDevOpsApprovalConditions({ requiredReviewers: false }),
        /at least one satisfaction condition/,
    );
});

test("conditions are carried onto the parsed approval target", () => {
    const target = parseAzureDevOpsPullRequestApprovalTarget(baseTarget({
        requiredPolicyDisplayNames: ["PVS/Smart Test Selection (git)"],
        codeReviewRecommendation: ["approve"],
    }));
    assert.equal(target.expectedSourceCommit, sourceCommit);
    assert.equal(target.conditions.requiredReviewers, false);
    assert.deepEqual(target.conditions.codeReviewRecommendation, ["approve"]);
});

test("a target without conditions still parses with the strict default", () => {
    const target = parseAzureDevOpsPullRequestApprovalTarget(baseTarget(undefined));
    assert.equal(target.conditions.requireAllBlockingPolicies, true);
    assert.equal(target.conditions.requiredReviewers, true);
});
