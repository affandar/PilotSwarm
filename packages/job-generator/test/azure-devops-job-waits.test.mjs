import assert from "node:assert/strict";
import test from "node:test";
import {
    AzureDevOpsPullRequestApprovalObserver as BaseAzureDevOpsPullRequestApprovalObserver,
    AzureDevOpsPullRequestClient,
    JobDefinitionAzureDevOpsTargetAuthorizer,
    accelerateAzureDevOpsPullRequestApprovalWaits,
    parseAzureDevOpsRepositoryBindings,
} from "../dist/azure-devops-job-waits.js";
import { azureDevOpsPullRequestResourceKey } from "pilotswarm-sdk";

const sourceCommit = "a".repeat(40);

function target(overrides = {}) {
    const identity = {
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
        ...overrides,
    };
    return {
        ...identity,
        expectedSourceCommit: overrides.expectedSourceCommit ?? sourceCommit,
        resourceKey: azureDevOpsPullRequestResourceKey(identity),
    };
}

function operation(request = target()) {
    return {
        operationId: "operation-1",
        definitionId: "definition-1",
        provider: "azure_devops",
        kind: "pull_request_approval",
        request,
    };
}

function wait() {
    return {
        waitId: "wait-1",
        definitionId: "definition-1",
        checkAttempts: 1,
    };
}

const allowTarget = {
    async authorize() {},
};

class AzureDevOpsPullRequestApprovalObserver
    extends BaseAzureDevOpsPullRequestApprovalObserver {
    constructor(client, authorizer = allowTarget) {
        super(client, authorizer);
    }
}

function response(body, status = 200) {
    return new Response(
        body === null ? null : JSON.stringify(body),
        {
            status,
            headers: { "content-type": "application/json" },
        },
    );
}

function providerFetch(overrides = {}) {
    const requests = [];
    const defaultPullRequest = {
        pullRequestId: 42,
        status: "active",
        sourceRefName: "refs/heads/users/test",
        targetRefName: "refs/heads/main",
        lastContentUpdatedDate: "2026-08-31T20:00:00.000Z",
        lastMergeSourceCommit: { commitId: sourceCommit },
        repository: {
            id: "repo-1",
            project: { id: "project-guid" },
        },
        ...overrides.pullRequest,
    };
    const pullRequests = overrides.pullRequestSequence ?? [defaultPullRequest];
    let pullRequestIndex = 0;
    const reviewers = overrides.reviewers ?? [
        {
            id: "reviewer-1",
            displayName: "Required Reviewer",
            uniqueName: "reviewer@example.com",
            isRequired: true,
            vote: 10,
        },
    ];
    const policies = overrides.policies ?? [
        {
            evaluationId: "evaluation-1",
            status: "approved",
            startedDate: "2026-08-31T19:59:00.000Z",
            completedDate: "2026-08-31T20:00:00.000Z",
            configuration: {
                id: 7,
                isEnabled: true,
                isBlocking: true,
                type: {
                    id: "policy-type-1",
                    displayName: "Required reviewers",
                },
            },
        },
    ];
    return {
        requests,
        fetch: async (url, init) => {
            const endpoint = new URL(url);
            requests.push({ endpoint, init });
            if (endpoint.pathname.endsWith("/reviewers")) {
                return response({ value: reviewers });
            }
            if (endpoint.pathname.endsWith("/policy/evaluations")) {
                return response({ value: policies });
            }
            if (overrides.pullRequestStatus) {
                return response(
                    overrides.pullRequestStatus.body ?? null,
                    overrides.pullRequestStatus.status,
                );
            }
            const pullRequest = pullRequests[
                Math.min(pullRequestIndex, pullRequests.length - 1)
            ];
            pullRequestIndex += 1;
            return response(pullRequest);
        },
    };
}

test("Azure DevOps approval observer satisfies current approved policies", async () => {
    const provider = providerFetch({
        policies: [
            {
                evaluationId: "evaluation-optional",
                status: "rejected",
                configuration: {
                    id: 6,
                    isEnabled: true,
                    isBlocking: false,
                    type: { id: "optional", displayName: "Optional check" },
                },
            },
            {
                evaluationId: "evaluation-required",
                status: "approved",
                configuration: {
                    id: 7,
                    isEnabled: true,
                    isBlocking: true,
                    type: { id: "required", displayName: "Required reviewers" },
                },
            },
            {
                evaluationId: "evaluation-not-applicable",
                status: "notApplicable",
                configuration: {
                    id: 8,
                    isEnabled: true,
                    isBlocking: true,
                    type: { id: "paths", displayName: "Path-specific validation" },
                },
            },
        ],
    });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "satisfied");
    assert.equal(result.result.approved, true);
    assert.equal(result.result.sourceCommit, sourceCommit);
    assert.equal(result.evidence.requiredReviewers[0].approved, true);
    assert.equal(result.evidence.policies.length, 3);
    assert.match(result.cursor, new RegExp(sourceCommit));
    assert.equal(provider.requests.length, 4);
    for (const request of provider.requests) {
        assert.equal(
            new Headers(request.init.headers).get("authorization"),
            "Bearer ado-token",
        );
    }
    const policyRequest = provider.requests.find(
        ({ endpoint }) => endpoint.pathname.endsWith("/policy/evaluations"),
    );
    assert.equal(
        policyRequest.endpoint.searchParams.get("artifactId"),
        "vstfs:///CodeReview/CodeReviewId/project-guid/42",
    );
});

test("Azure DevOps approval observer remains pending for required review or policy work", async () => {
    const provider = providerFetch({
        reviewers: [{
            id: "reviewer-1",
            isRequired: true,
            vote: 0,
        }],
        policies: [{
            evaluationId: "evaluation-1",
            status: "running",
            configuration: {
                id: 7,
                isEnabled: true,
                isBlocking: true,
                type: { id: "required", displayName: "Required reviewers" },
            },
        }],
    });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "pending");
    assert.deepEqual(result.observation.pendingReviewerIds, ["reviewer-1"]);
    assert.deepEqual(result.observation.pendingPolicyEvaluationIds, ["evaluation-1"]);
});

test("Azure DevOps approval observer rejects a changed source commit", async () => {
    const changedCommit = "b".repeat(40);
    const provider = providerFetch({
        pullRequest: {
            lastMergeSourceCommit: { commitId: changedCommit },
        },
    });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "failed");
    assert.equal(result.result.reason, "source_commit_changed");
    assert.equal(result.result.sourceCommit, changedCommit);
    assert.match(result.error, /source commit changed/);
});

test("Azure DevOps approval observer rejects a source push during policy observation", async () => {
    const changedCommit = "b".repeat(40);
    const basePullRequest = {
        pullRequestId: 42,
        status: "active",
        sourceRefName: "refs/heads/users/test",
        targetRefName: "refs/heads/main",
        lastContentUpdatedDate: "2026-08-31T20:00:00.000Z",
        repository: {
            id: "repo-1",
            project: { id: "project-guid" },
        },
    };
    const provider = providerFetch({
        pullRequestSequence: [
            {
                ...basePullRequest,
                lastMergeSourceCommit: { commitId: sourceCommit },
            },
            {
                ...basePullRequest,
                lastContentUpdatedDate: "2026-08-31T20:01:00.000Z",
                lastMergeSourceCommit: { commitId: changedCommit },
            },
        ],
    });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "failed");
    assert.equal(result.result.reason, "source_commit_changed");
    assert.equal(result.result.sourceCommit, changedCommit);
    assert.equal(provider.requests.length, 4);
});

test("Azure DevOps approval observer records an abandoned pull request as failed", async () => {
    const provider = providerFetch({ pullRequest: { status: "abandoned" } });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "failed");
    assert.equal(result.result.reason, "pull_request_abandoned");
});

test("Azure DevOps approval observer handles a missing pull request terminally", async () => {
    const provider = providerFetch({
        pullRequestStatus: { status: 404, body: { message: "not found" } },
    });
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "failed");
    assert.equal(result.result.reason, "pull_request_not_found");
    assert.equal(provider.requests.length, 1);
});

test("Azure DevOps pull-request events only accelerate matching approval waits", async () => {
    const calls = [];
    const checkAt = new Date("2026-08-31T20:00:00.000Z");
    const identity = {
        organization: "https://dev.azure.com/Contoso/",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
    };
    const count = await accelerateAzureDevOpsPullRequestApprovalWaits(
        {
            async accelerateJobWaitChecksByTarget(provider, kind, resourceKey, at) {
                calls.push({ provider, kind, resourceKey, at });
                return 2;
            },
        },
        identity,
        checkAt,
    );

    assert.equal(count, 2);
    assert.deepEqual(calls, [{
        provider: "azure_devops",
        kind: "pull_request_approval",
        resourceKey: azureDevOpsPullRequestResourceKey({
            ...identity,
            organization: "Contoso",
        }),
        at: checkAt,
    }]);
});

test("Azure DevOps client supports PAT authentication without exposing it in evidence", async () => {
    const provider = providerFetch();
    const pat = "test-pat";
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            pat,
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "satisfied");
    assert.equal(
        new Headers(provider.requests[0].init.headers).get("authorization"),
        `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`,
    );
    assert.equal(JSON.stringify(result).includes(pat), false);
});

test("Azure DevOps client prefers an explicit bearer token over PAT fallback", async () => {
    const provider = providerFetch();
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            pat: "fallback-pat",
            fetch: provider.fetch,
        }),
    );

    const result = await observer.observe({ wait: wait(), operation: operation() });

    assert.equal(result.disposition, "satisfied");
    assert.equal(
        new Headers(provider.requests[0].init.headers).get("authorization"),
        "Bearer ado-token",
    );
});

test("Azure DevOps observer authorizes the Job repository before provider reads", async () => {
    const provider = providerFetch();
    const observer = new AzureDevOpsPullRequestApprovalObserver(
        new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: provider.fetch,
        }),
        {
            async authorize() {
                throw new Error("target is not authorized");
            },
        },
    );

    await assert.rejects(
        observer.observe({ wait: wait(), operation: operation() }),
        /target is not authorized/,
    );
    assert.equal(provider.requests.length, 0);
});

test("Azure DevOps target authorization binds immutable Job affinity to repository", async () => {
    const bindings = parseAzureDevOpsRepositoryBindings(JSON.stringify([{
        repo: "service-repo",
        organization: "https://dev.azure.com/Contoso/",
        project: "Project",
        repositoryId: "repo-1",
    }]));
    const authorizer = new JobDefinitionAzureDevOpsTargetAuthorizer(
        {
            async getJobGeneratorDefinition(definitionId) {
                assert.equal(definitionId, "definition-1");
                return { affinities: { repo: "Service-Repo" } };
            },
        },
        bindings,
    );

    await authorizer.authorize({
        wait: wait(),
        operation: operation(),
        target: target(),
    });
    await assert.rejects(
        authorizer.authorize({
            wait: wait(),
            operation: operation(target({ repositoryId: "repo-2" })),
            target: target({ repositoryId: "repo-2" }),
        }),
        /outside Job affinity service-repo/,
    );
});

test("Azure DevOps repository bindings reject duplicate affinities", () => {
    const entry = {
        repo: "service-repo",
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
    };
    assert.throws(
        () => parseAzureDevOpsRepositoryBindings(JSON.stringify([entry, entry])),
        /duplicate repo service-repo/,
    );
});
