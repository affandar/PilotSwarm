import assert from "node:assert/strict";
import test from "node:test";
import {
    AzureDevOpsPullRequestApprovalObserver,
    AzureDevOpsPullRequestClient,
    AzureDevOpsPullRequestCompletionObserver,
    JobDefinitionAzureDevOpsTargetAuthorizer,
    parseAzureDevOpsRepositoryBindings,
} from "../dist/azure-devops-job-waits.js";
import { JobWaitScheduler, azureDevOpsPullRequestResourceKey } from "pilotswarm-sdk";

// Layer-2 fake-ADO durable integration test for WI 5575582.
//
// It drives a durable Job through the delivery lifecycle
//   PRPublished -> HumanCodeReviewApproved -> Committed
// using the production Azure DevOps approval and completion observers and the
// production JobWaitScheduler, against a durable in-memory store that mimics the
// PostgreSQL catalog's claim/complete/signal semantics. Azure DevOps is faked
// through an injected fetch whose pull-request, reviewer, and policy state the
// test advances to model a real human approval and a real human PR completion.
//
// The scheduler is discarded and rebuilt between the two external waits to prove
// the wait survives a controller/worker restart: no duplicate pull request or
// operation, no redelivered transition, no skipped state, and zero Job-worker
// occupancy while a wait is outstanding.

const DEFINITION_ID = "definition-1";
const SESSION_ID = "session-1";
const JOB_ID = "job-1";
const AFFINITY_REPO = "demo-repo";
const ORGANIZATION = "Contoso";
const PROJECT = "Project";
const REPOSITORY_ID = "repo-1";
const PROJECT_GUID = "project-guid";
const PULL_REQUEST_ID = 42;
const SOURCE_COMMIT = "a".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
const TARGET_REF = "refs/heads/main";
const SOURCE_REF = "refs/heads/users/demo";

function approvalTarget() {
    const identity = {
        organization: ORGANIZATION,
        project: PROJECT,
        repositoryId: REPOSITORY_ID,
        pullRequestId: PULL_REQUEST_ID,
    };
    return {
        ...identity,
        expectedSourceCommit: SOURCE_COMMIT,
        resourceKey: azureDevOpsPullRequestResourceKey(identity),
    };
}

function jsonResponse(body, status = 200) {
    return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

// A single mutable Azure DevOps pull-request whose reviewer approval and
// completion the test toggles to model real human actions. Both observers read
// the same pull-request endpoint; the approval observer additionally reads the
// reviewers and policy-evaluation endpoints.
function createFakeAzureDevOps() {
    const state = { approved: false, completed: false };
    const counts = { pullRequest: 0, reviewers: 0, policies: 0 };

    function pullRequestBody() {
        const body = {
            pullRequestId: PULL_REQUEST_ID,
            status: state.completed ? "completed" : "active",
            sourceRefName: SOURCE_REF,
            targetRefName: TARGET_REF,
            lastContentUpdatedDate: "2026-08-31T20:00:00.000Z",
            lastMergeSourceCommit: { commitId: SOURCE_COMMIT },
            repository: { id: REPOSITORY_ID, project: { id: PROJECT_GUID } },
        };
        if (state.completed) {
            body.status = "completed";
            body.lastMergeCommit = { commitId: MERGE_COMMIT };
            body.mergeStatus = "succeeded";
            body.closedDate = "2026-08-31T20:05:00.000Z";
            body.closedBy = {
                id: "closer-1",
                displayName: "Release Approver",
                uniqueName: "approver@example.com",
            };
        }
        return body;
    }

    const fetchImpl = async (url) => {
        const endpoint = new URL(url);
        if (endpoint.pathname.endsWith("/reviewers")) {
            counts.reviewers += 1;
            return jsonResponse({
                value: [{
                    id: "reviewer-1",
                    displayName: "Required Reviewer",
                    uniqueName: "reviewer@example.com",
                    isRequired: true,
                    vote: state.approved ? 10 : 0,
                }],
            });
        }
        if (endpoint.pathname.endsWith("/policy/evaluations")) {
            counts.policies += 1;
            return jsonResponse({
                value: [{
                    evaluationId: "evaluation-1",
                    status: "approved",
                    startedDate: "2026-08-31T19:59:00.000Z",
                    completedDate: "2026-08-31T20:00:00.000Z",
                    configuration: {
                        id: 7,
                        isEnabled: true,
                        isBlocking: true,
                        type: { id: "required", displayName: "Required reviewers" },
                    },
                }],
            });
        }
        counts.pullRequest += 1;
        return jsonResponse(pullRequestBody());
    };

    return { state, counts, fetch: fetchImpl };
}

// Durable in-memory JobWait store mirroring the PostgreSQL catalog behaviour the
// JobWaitScheduler depends on: lease-based claiming that skips terminal waits,
// cursor/observation persistence, satisfied/failed waits publishing a
// deliver-once external-operation signal, and idempotent signal delivery.
function createDurableStore() {
    const waits = new Map();
    const operations = new Map();

    function selectorMatches(selectors, operation) {
        if (!selectors || selectors.length === 0) return true;
        return selectors.some((selector) =>
            selector.provider === operation.provider
            && (selector.kind === undefined || selector.kind === operation.kind));
    }

    const store = {
        seedOperation(operation) {
            operations.set(operation.operationId, {
                status: "pending",
                result: null,
                evidence: null,
                error: null,
                signalReady: false,
                signalDelivered: false,
                signalLeaseUntil: 0,
                signalNextAt: 0,
                ...operation,
            });
        },
        seedWait(wait) {
            waits.set(wait.waitId, {
                status: "pending",
                providerCursor: null,
                latestObservation: null,
                deadlineAt: null,
                checkAttempts: 0,
                consecutiveCheckFailures: 0,
                nextCheckAt: 0,
                leaseUntil: 0,
                evidence: null,
                result: null,
                error: null,
                ...wait,
            });
        },
        getWait(waitId) {
            return waits.get(waitId);
        },
        getOperationRecord(operationId) {
            return operations.get(operationId);
        },
        operationCount() {
            return operations.size;
        },
        makeAllDue() {
            for (const wait of waits.values()) {
                if (wait.status === "pending") wait.nextCheckAt = 0;
            }
        },

        async claimDueJobWaits(workerId, limit, leaseSeconds, selectors) {
            const now = Date.now();
            const claimed = [];
            for (const wait of waits.values()) {
                if (claimed.length >= limit) break;
                if (wait.status !== "pending") continue;
                if (wait.nextCheckAt > now) continue;
                if (wait.leaseUntil > now) continue;
                const operation = operations.get(wait.externalOperationId);
                if (!operation) continue;
                if (!selectorMatches(selectors, operation)) continue;
                wait.leaseUntil = now + leaseSeconds * 1000;
                wait.checkAttempts += 1;
                claimed.push({
                    waitId: wait.waitId,
                    jobId: wait.jobId,
                    stateRunId: wait.stateRunId,
                    definitionId: wait.definitionId,
                    sessionId: wait.sessionId,
                    externalOperationId: wait.externalOperationId,
                    providerCursor: wait.providerCursor,
                    latestObservation: wait.latestObservation,
                    deadlineAt: wait.deadlineAt,
                    checkAttempts: wait.checkAttempts,
                    consecutiveCheckFailures: wait.consecutiveCheckFailures,
                });
            }
            return claimed;
        },

        async completeJobWaitCheck(input) {
            const wait = waits.get(input.waitId);
            if (!wait) throw new Error(`Unknown wait: ${input.waitId}`);
            wait.leaseUntil = 0;
            wait.latestObservation = input.observation ?? wait.latestObservation;
            if (input.providerCursor !== undefined) {
                wait.providerCursor = input.providerCursor;
            }
            if (input.disposition === "pending") {
                if (wait.deadlineAt && wait.deadlineAt.getTime() <= Date.now()) {
                    wait.status = "timed_out";
                    return { status: "timed_out" };
                }
                wait.consecutiveCheckFailures = input.error
                    ? wait.consecutiveCheckFailures + 1
                    : 0;
                wait.nextCheckAt = input.nextCheckAt
                    ? input.nextCheckAt.getTime()
                    : Date.now();
                return { status: "pending" };
            }
            wait.status = input.disposition;
            wait.evidence = input.evidence ?? null;
            wait.result = input.result ?? null;
            wait.error = input.error ?? null;
            const operation = operations.get(wait.externalOperationId);
            if (operation) {
                operation.status = input.disposition === "satisfied" ? "succeeded" : "failed";
                operation.result = input.result ?? null;
                operation.evidence = input.evidence ?? null;
                operation.error = input.error ?? null;
                operation.signalReady = true;
            }
            return { status: input.disposition };
        },

        async getJobExternalOperation(sessionId, operationId) {
            const operation = operations.get(operationId);
            if (!operation || operation.sessionId !== sessionId) return null;
            return {
                operationId: operation.operationId,
                jobId: operation.jobId,
                stateRunId: operation.stateRunId,
                definitionId: operation.definitionId,
                createdSessionId: operation.sessionId,
                sessionId: operation.sessionId,
                provider: operation.provider,
                kind: operation.kind,
                operationKey: operation.operationKey,
                idempotencyKey: operation.operationKey,
                correlationId: operation.correlationId,
                signalKey: operation.signalKey,
                request: operation.request,
                status: operation.status,
                result: operation.result,
                evidence: operation.evidence,
                error: operation.error,
            };
        },

        async claimJobExternalOperationSignals(workerId, limit, leaseSeconds) {
            const now = Date.now();
            const claimed = [];
            for (const operation of operations.values()) {
                if (claimed.length >= limit) break;
                if (!operation.signalReady || operation.signalDelivered) continue;
                if (operation.signalLeaseUntil > now) continue;
                if (operation.signalNextAt > now) continue;
                operation.signalLeaseUntil = now + leaseSeconds * 1000;
                claimed.push({
                    operationId: operation.operationId,
                    sessionId: operation.sessionId,
                    signalKey: operation.signalKey,
                    correlationId: operation.correlationId,
                    provider: operation.provider,
                    kind: operation.kind,
                    status: operation.status,
                    result: operation.result,
                    evidence: operation.evidence,
                    error: operation.error,
                });
            }
            return claimed;
        },

        async markJobExternalOperationSignalDelivered(operationId) {
            const operation = operations.get(operationId);
            if (operation) {
                operation.signalDelivered = true;
                operation.signalLeaseUntil = 0;
            }
        },

        async markJobExternalOperationSignalFailed(operationId, workerId, error, retryAt) {
            const operation = operations.get(operationId);
            if (operation) {
                operation.signalLeaseUntil = 0;
                operation.signalNextAt = retryAt instanceof Date ? retryAt.getTime() : 0;
            }
        },
    };
    return store;
}

function approvalOperationRow() {
    const target = approvalTarget();
    return {
        operationId: "operation-approval",
        jobId: JOB_ID,
        stateRunId: "run-prpublished",
        definitionId: DEFINITION_ID,
        sessionId: SESSION_ID,
        provider: "azure_devops",
        kind: "pull_request_approval",
        operationKey: `approval:${target.resourceKey}`,
        correlationId: "azure_devops:operation-approval",
        signalKey: "job-operation:operation-approval",
        request: target,
    };
}

function completionOperationRow() {
    const target = approvalTarget();
    return {
        operationId: "operation-completion",
        jobId: JOB_ID,
        stateRunId: "run-approved",
        definitionId: DEFINITION_ID,
        sessionId: SESSION_ID,
        provider: "azure_devops",
        kind: "pull_request_completion",
        operationKey: `completion:${target.resourceKey}`,
        correlationId: "azure_devops:operation-completion",
        signalKey: "job-operation:operation-completion",
        request: target,
    };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test(
    "durable Job advances PRPublished -> HumanCodeReviewApproved -> Committed across a scheduler restart",
    async () => {
        const ado = createFakeAzureDevOps();
        const store = createDurableStore();

        const client = new AzureDevOpsPullRequestClient({
            token: "ado-token",
            fetch: ado.fetch,
        });
        const bindings = parseAzureDevOpsRepositoryBindings(JSON.stringify([{
            repo: AFFINITY_REPO,
            organization: ORGANIZATION,
            project: PROJECT,
            repositoryId: REPOSITORY_ID,
        }]));
        const authorizer = new JobDefinitionAzureDevOpsTargetAuthorizer(
            {
                async getJobGeneratorDefinition(definitionId) {
                    assert.equal(definitionId, DEFINITION_ID);
                    return { affinities: { repo: AFFINITY_REPO } };
                },
            },
            bindings,
        );
        const observers = [
            new AzureDevOpsPullRequestApprovalObserver(client, authorizer),
            new AzureDevOpsPullRequestCompletionObserver(client, authorizer),
        ];

        // Lifecycle bookkeeping owned by the "controller + worker": the signal
        // receiver advances the state machine and the worker starts the next
        // external operation. Worker occupancy is only ever incurred here, never
        // while a wait is outstanding.
        const lifecycle = { state: "PRPublished" };
        const transitions = [];
        const deliveredSignals = [];
        const processedSignals = new Set();
        let completionOperationCreations = 0;
        let workerActivations = 0;

        const signalSender = {
            async sendSystemSignal(sessionId, signalKey, payload) {
                assert.equal(sessionId, SESSION_ID);
                if (processedSignals.has(payload.operationId)) {
                    throw new Error(`Signal redelivered for ${payload.operationId}`);
                }
                processedSignals.add(payload.operationId);
                deliveredSignals.push({ signalKey, ...payload });
                workerActivations += 1;

                if (payload.kind === "pull_request_approval" && payload.status === "succeeded") {
                    assert.equal(
                        lifecycle.state,
                        "PRPublished",
                        "approval must advance from PRPublished, never skip a state",
                    );
                    lifecycle.state = "HumanCodeReviewApproved";
                    transitions.push("HumanCodeReviewApproved");
                    // Worker reaches HumanCodeReviewApproved and starts the PR
                    // completion wait. Guard against duplicate operations.
                    if (!store.getOperationRecord("operation-completion")) {
                        completionOperationCreations += 1;
                        store.seedOperation(completionOperationRow());
                        store.seedWait({
                            waitId: "wait-completion",
                            jobId: JOB_ID,
                            stateRunId: "run-approved",
                            definitionId: DEFINITION_ID,
                            sessionId: SESSION_ID,
                            externalOperationId: "operation-completion",
                        });
                    }
                    return;
                }
                if (payload.kind === "pull_request_completion" && payload.status === "succeeded") {
                    assert.equal(
                        lifecycle.state,
                        "HumanCodeReviewApproved",
                        "completion must advance from HumanCodeReviewApproved, never skip a state",
                    );
                    lifecycle.state = "Committed";
                    transitions.push("Committed");
                    return;
                }
                throw new Error(`Unexpected signal ${payload.kind}/${payload.status}`);
            },
        };

        function newScheduler(workerId) {
            return new JobWaitScheduler({
                store,
                signalSender,
                observers,
                workerId,
                defaultCheckIntervalMs: 5,
                claimLimit: 10,
                leaseSeconds: 30,
                logger: quietLogger,
            });
        }

        // --- PRPublished: worker released, only the approval wait is durable. ---
        store.seedOperation(approvalOperationRow());
        store.seedWait({
            waitId: "wait-approval",
            jobId: JOB_ID,
            stateRunId: "run-prpublished",
            definitionId: DEFINITION_ID,
            sessionId: SESSION_ID,
            externalOperationId: "operation-approval",
        });

        const schedulerA = newScheduler("wait-scheduler-a");

        // Poll several times while the reviewer has not yet approved. The wait
        // stays pending, no transition happens, and the worker stays idle.
        const pollsBeforeApproval = 3;
        for (let i = 0; i < pollsBeforeApproval; i += 1) {
            store.makeAllDue();
            const result = await schedulerA.runOnce();
            assert.equal(result.pending, 1);
            assert.equal(result.satisfied, 0);
            assert.equal(result.delivered, 0);
        }
        assert.equal(
            workerActivations,
            0,
            "no worker occupancy while awaiting human review",
        );
        assert.equal(transitions.length, 0);
        assert.ok(
            ado.counts.pullRequest >= pollsBeforeApproval,
            "the approval observer durably re-polled Azure DevOps",
        );
        assert.equal(store.getWait("wait-approval").status, "pending");

        // Reviewer approves in Azure DevOps.
        ado.state.approved = true;
        store.makeAllDue();
        const approvalRun = await schedulerA.runOnce();
        assert.equal(approvalRun.satisfied, 1);
        assert.equal(approvalRun.delivered, 1);

        assert.equal(lifecycle.state, "HumanCodeReviewApproved");
        assert.deepEqual(transitions, ["HumanCodeReviewApproved"]);
        assert.equal(store.getWait("wait-approval").status, "satisfied");
        assert.equal(
            ado.state.completed,
            false,
            "approval must never complete the pull request automatically",
        );
        assert.equal(store.getOperationRecord("operation-approval").signalDelivered, true);

        // --- Restart: discard scheduler A and rebuild before the second wait. ---
        const schedulerB = newScheduler("wait-scheduler-b");

        // The restarted scheduler must not re-observe the satisfied approval wait
        // nor redeliver its signal; it only sees the pending completion wait.
        store.makeAllDue();
        const afterRestart = await schedulerB.runOnce();
        assert.equal(afterRestart.satisfied, 0, "satisfied approval wait is not re-observed");
        assert.equal(afterRestart.delivered, 0, "approval signal is not redelivered");
        assert.equal(afterRestart.pending, 1, "completion wait polls durably after restart");
        assert.deepEqual(transitions, ["HumanCodeReviewApproved"]);

        const completionPollsBefore = ado.state.completed ? 0 : 2;
        for (let i = 0; i < completionPollsBefore; i += 1) {
            store.makeAllDue();
            const result = await schedulerB.runOnce();
            assert.equal(result.pending, 1);
            assert.equal(result.satisfied, 0);
        }

        // Authorized human completes the pull request in Azure DevOps.
        ado.state.completed = true;
        store.makeAllDue();
        const completionRun = await schedulerB.runOnce();
        assert.equal(completionRun.satisfied, 1);
        assert.equal(completionRun.delivered, 1);

        // Final drained tick proves the terminal lifecycle is idempotent.
        store.makeAllDue();
        const drained = await schedulerB.runOnce();
        assert.equal(drained.checked, 0);
        assert.equal(drained.satisfied, 0);
        assert.equal(drained.delivered, 0);

        // --- Assertions: state sequence, evidence, and durability guarantees. ---
        assert.equal(lifecycle.state, "Committed");
        assert.deepEqual(
            transitions,
            ["HumanCodeReviewApproved", "Committed"],
            "no skipped state and no duplicated transition",
        );

        assert.equal(deliveredSignals.length, 2, "each transition delivered exactly one signal");
        assert.equal(
            new Set(deliveredSignals.map((signal) => signal.operationId)).size,
            2,
            "no signal was redelivered",
        );

        assert.equal(store.operationCount(), 2, "no duplicate pull-request operation was created");
        assert.equal(completionOperationCreations, 1, "the completion operation was created once");
        assert.equal(workerActivations, 2, "the worker only ran at the two transitions");

        const completionWait = store.getWait("wait-completion");
        assert.equal(completionWait.status, "satisfied");
        assert.equal(completionWait.result.completed, true);
        assert.equal(completionWait.result.mergeCommit, MERGE_COMMIT);
        assert.equal(completionWait.result.sourceCommit, SOURCE_COMMIT);
        assert.equal(completionWait.result.targetRefName, TARGET_REF);
        assert.equal(completionWait.evidence.completedBy.uniqueName, "approver@example.com");
        assert.equal(completionWait.evidence.mergeStatus, "succeeded");
        assert.equal(completionWait.evidence.mergeCommit, MERGE_COMMIT);
    },
);
