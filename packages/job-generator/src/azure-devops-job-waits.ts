import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
    AZURE_DEVOPS_JOB_WAIT_PROVIDER,
    AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND,
    AZURE_DEVOPS_PULL_REQUEST_COMPLETION_KIND,
    azureDevOpsPullRequestResourceKey,
    parseAzureDevOpsPullRequestApprovalTarget,
    parseAzureDevOpsPullRequestIdentity,
    type AzureDevOpsPullRequestApprovalTarget,
    type AzureDevOpsPullRequestIdentity,
    type JobExternalOperationRow,
    type JobWaitObservation,
    type JobWaitObserver,
    type JobWaitRow,
    type SessionCatalog,
} from "pilotswarm-sdk";

const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

type FetchLike = typeof fetch;

interface AzureDevOpsPullRequest {
    pullRequestId: number;
    status: string;
    sourceRefName: string | null;
    targetRefName: string | null;
    lastContentUpdatedDate: string | null;
    sourceCommit: string;
    mergeCommit: string | null;
    closedByDisplayName: string | null;
    closedByUniqueName: string | null;
    closedById: string | null;
    closedDate: string | null;
    mergeStatus: string | null;
    projectId: string;
}

interface AzureDevOpsReviewer {
    id: string;
    displayName: string | null;
    uniqueName: string | null;
    isRequired: boolean;
    vote: number;
}

interface AzureDevOpsPolicyEvaluation {
    evaluationId: string;
    configurationId: number | null;
    typeId: string | null;
    typeName: string | null;
    displayName: string | null;
    isEnabled: boolean;
    isBlocking: boolean;
    status: "queued" | "running" | "approved" | "rejected" | "notApplicable" | "broken";
    startedDate: string | null;
    completedDate: string | null;
}

export interface AzureDevOpsPullRequestApprovalSnapshot {
    pullRequest: AzureDevOpsPullRequest;
    reviewers: AzureDevOpsReviewer[];
    policies: AzureDevOpsPolicyEvaluation[];
}

export interface AzureDevOpsPullRequestCompletionSnapshot {
    pullRequest: AzureDevOpsPullRequest;
}

export interface AzureDevOpsPullRequestClientOptions {
    token?: string;
    pat?: string;
    credential?: TokenCredential;
    fetch?: FetchLike;
}

export interface AzureDevOpsRepositoryBinding {
    repo: string;
    organization: string;
    project: string;
    repositoryId: string;
}

export type AzureDevOpsPullRequestAuthorizationStore = Pick<
    SessionCatalog,
    "getJobGeneratorDefinition"
>;

export interface AzureDevOpsPullRequestTargetAuthorizer {
    authorize(input: {
        wait: JobWaitRow;
        operation: JobExternalOperationRow;
        target: AzureDevOpsPullRequestApprovalTarget;
    }): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function optionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, label: string): string {
    const result = optionalString(value);
    if (!result) throw new Error(`Azure DevOps ${label} is missing`);
    return result;
}

function repositoryAffinity(value: unknown): string {
    const result = requiredString(value, "repository binding affinity").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result)) {
        throw new Error(`Azure DevOps repository binding affinity is invalid: ${result}`);
    }
    return result;
}

function repositoryIdentityKey(value: {
    organization: string;
    project: string;
    repositoryId: string;
}): string {
    return [
        value.organization,
        value.project,
        value.repositoryId,
    ].map((component) => component.trim().toLowerCase()).join("\0");
}

export function parseAzureDevOpsRepositoryBindings(
    value: string | undefined,
): ReadonlyMap<string, AzureDevOpsRepositoryBinding> {
    if (!value?.trim()) return new Map();
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error("JOBGEN_ADO_REPOSITORY_BINDINGS must be valid JSON", {
            cause: error,
        });
    }
    if (!Array.isArray(parsed)) {
        throw new Error("JOBGEN_ADO_REPOSITORY_BINDINGS must be a JSON array");
    }
    const bindings = new Map<string, AzureDevOpsRepositoryBinding>();
    for (const [index, entry] of parsed.entries()) {
        const binding = record(entry);
        if (Object.keys(binding).length === 0) {
            throw new Error(`JOBGEN_ADO_REPOSITORY_BINDINGS entry ${index} is empty`);
        }
        const repo = repositoryAffinity(binding.repo);
        if (bindings.has(repo)) {
            throw new Error(`JOBGEN_ADO_REPOSITORY_BINDINGS contains duplicate repo ${repo}`);
        }
        const target = parseAzureDevOpsPullRequestIdentity({
            organization: binding.organization,
            project: binding.project,
            repositoryId: binding.repositoryId,
            pullRequestId: 1,
        });
        bindings.set(repo, {
            repo,
            organization: target.organization,
            project: target.project,
            repositoryId: target.repositoryId,
        });
    }
    return bindings;
}

export class JobDefinitionAzureDevOpsTargetAuthorizer
    implements AzureDevOpsPullRequestTargetAuthorizer {
    constructor(
        private readonly store: AzureDevOpsPullRequestAuthorizationStore,
        private readonly bindings: ReadonlyMap<string, AzureDevOpsRepositoryBinding>,
    ) {}

    async authorize(input: {
        wait: JobWaitRow;
        operation: JobExternalOperationRow;
        target: AzureDevOpsPullRequestApprovalTarget;
    }): Promise<void> {
        if (input.operation.definitionId !== input.wait.definitionId) {
            throw new Error("Azure DevOps operation definition does not match its JobWait");
        }
        const definition = await this.store.getJobGeneratorDefinition(input.wait.definitionId);
        const repo = repositoryAffinity(record(definition.affinities).repo);
        const binding = this.bindings.get(repo);
        if (!binding) {
            throw new Error(
                `Azure DevOps repository access is not configured for Job affinity ${repo}`,
            );
        }
        if (repositoryIdentityKey(binding) !== repositoryIdentityKey(input.target)) {
            throw new Error(
                `Azure DevOps pull-request target is outside Job affinity ${repo}`,
            );
        }
    }
}

function jsonCollection(value: unknown, label: string): unknown[] {
    if (Array.isArray(value)) return value;
    const body = record(value);
    if (!Array.isArray(body.value)) {
        throw new Error(`Azure DevOps ${label} response is malformed`);
    }
    return body.value;
}

function pullRequestEndpoint(
    target: AzureDevOpsPullRequestIdentity,
    suffix = "",
): URL {
    const root = [
        "https://dev.azure.com",
        encodeURIComponent(target.organization),
        encodeURIComponent(target.project),
        "_apis",
        "git",
        "repositories",
        encodeURIComponent(target.repositoryId),
        "pullRequests",
        String(target.pullRequestId),
    ].join("/");
    const endpoint = new URL(`${root}${suffix}`);
    endpoint.searchParams.set("api-version", "7.1");
    return endpoint;
}

function policyEvaluationsEndpoint(
    target: AzureDevOpsPullRequestIdentity,
    projectId: string,
): URL {
    const endpoint = new URL(
        [
            "https://dev.azure.com",
            encodeURIComponent(target.organization),
            encodeURIComponent(target.project),
            "_apis",
            "policy",
            "evaluations",
        ].join("/"),
    );
    endpoint.searchParams.set(
        "artifactId",
        `vstfs:///CodeReview/CodeReviewId/${projectId}/${target.pullRequestId}`,
    );
    endpoint.searchParams.set("api-version", "7.1-preview.1");
    return endpoint;
}

function parsePullRequest(
    value: unknown,
    target: AzureDevOpsPullRequestApprovalTarget,
): AzureDevOpsPullRequest {
    const pullRequest = record(value);
    const repository = record(pullRequest.repository);
    const project = record(repository.project);
    const pullRequestId = Number(pullRequest.pullRequestId);
    if (pullRequestId !== target.pullRequestId) {
        throw new Error("Azure DevOps pull-request response returned an unexpected pullRequestId");
    }
    const repositoryId = requiredString(repository.id, "pull-request repository ID");
    if (repositoryId.toLowerCase() !== target.repositoryId.toLowerCase()) {
        throw new Error("Azure DevOps pull-request response returned an unexpected repository");
    }
    const sourceCommit = requiredString(
        record(pullRequest.lastMergeSourceCommit).commitId,
        "pull-request source commit",
    ).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
        throw new Error("Azure DevOps pull-request response returned an invalid source commit");
    }
    const mergeCommitId = optionalString(record(pullRequest.lastMergeCommit).commitId);
    const mergeCommit = mergeCommitId ? mergeCommitId.toLowerCase() : null;
    if (mergeCommit !== null && !/^[0-9a-f]{40}$/.test(mergeCommit)) {
        throw new Error("Azure DevOps pull-request response returned an invalid merge commit");
    }
    const closedBy = record(pullRequest.closedBy);
    return {
        pullRequestId,
        status: requiredString(pullRequest.status, "pull-request status").toLowerCase(),
        sourceRefName: optionalString(pullRequest.sourceRefName),
        targetRefName: optionalString(pullRequest.targetRefName),
        lastContentUpdatedDate: optionalString(pullRequest.lastContentUpdatedDate),
        sourceCommit,
        mergeCommit,
        closedByDisplayName: optionalString(closedBy.displayName),
        closedByUniqueName: optionalString(closedBy.uniqueName),
        closedById: optionalString(closedBy.id),
        closedDate: optionalString(pullRequest.closedDate),
        mergeStatus: optionalString(pullRequest.mergeStatus),
        projectId: requiredString(project.id, "pull-request project ID"),
    };
}

function parseReviewers(value: unknown): AzureDevOpsReviewer[] {
    return jsonCollection(value, "pull-request reviewers").map((entry, index) => {
        const reviewer = record(entry);
        const vote = Number(reviewer.vote);
        if (!Number.isFinite(vote)) {
            throw new Error(`Azure DevOps pull-request reviewer ${index} has an invalid vote`);
        }
        return {
            id: requiredString(reviewer.id, `pull-request reviewer ${index} ID`),
            displayName: optionalString(reviewer.displayName),
            uniqueName: optionalString(reviewer.uniqueName),
            isRequired: reviewer.isRequired === true,
            vote,
        };
    });
}

function parsePolicyEvaluations(value: unknown): AzureDevOpsPolicyEvaluation[] {
    const allowedStatuses = new Set([
        "queued",
        "running",
        "approved",
        "rejected",
        "notApplicable",
        "broken",
    ]);
    return jsonCollection(value, "policy evaluations").map((entry, index) => {
        const evaluation = record(entry);
        const configuration = record(evaluation.configuration);
        const type = record(configuration.type);
        const status = requiredString(
            evaluation.status,
            `policy evaluation ${index} status`,
        );
        if (!allowedStatuses.has(status)) {
            throw new Error(`Azure DevOps policy evaluation ${index} has an invalid status`);
        }
        if (typeof configuration.isEnabled !== "boolean"
            || typeof configuration.isBlocking !== "boolean") {
            throw new Error(`Azure DevOps policy evaluation ${index} has invalid configuration`);
        }
        const configurationId = Number(configuration.id);
        const settings = record(configuration.settings);
        return {
            evaluationId: requiredString(
                evaluation.evaluationId,
                `policy evaluation ${index} ID`,
            ),
            configurationId: Number.isInteger(configurationId) ? configurationId : null,
            typeId: optionalString(type.id),
            typeName: optionalString(type.displayName),
            displayName: optionalString(settings.displayName),
            isEnabled: configuration.isEnabled,
            isBlocking: configuration.isBlocking,
            status: status as AzureDevOpsPolicyEvaluation["status"],
            startedDate: optionalString(evaluation.startedDate),
            completedDate: optionalString(evaluation.completedDate),
        };
    });
}

export class AzureDevOpsPullRequestClient {
    private readonly token?: string;
    private readonly pat?: string;
    private credential?: TokenCredential;
    private readonly fetchImpl: FetchLike;

    constructor(options: AzureDevOpsPullRequestClientOptions = {}) {
        this.token = options.token?.trim() || undefined;
        this.pat = options.pat?.trim() || undefined;
        this.credential = options.credential;
        this.fetchImpl = options.fetch ?? fetch;
    }

    private async authorization(): Promise<string> {
        if (this.token) return `Bearer ${this.token}`;
        if (this.pat) {
            return `Basic ${Buffer.from(`:${this.pat}`, "utf8").toString("base64")}`;
        }
        const credentialToken = await (
            this.credential ??= new DefaultAzureCredential()
        ).getToken(AZURE_DEVOPS_SCOPE);
        const token = credentialToken?.token;
        if (!token) throw new Error("Azure DevOps authentication did not return an access token");
        return `Bearer ${token}`;
    }

    private async getJson(
        endpoint: URL,
        authorization: string,
        label: string,
        allowNotFound = false,
    ): Promise<unknown | null> {
        const response = await this.fetchImpl(endpoint, {
            headers: {
                accept: "application/json",
                authorization,
            },
        });
        if (allowNotFound && response.status === 404) return null;
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 2_000);
            throw new Error(
                `Azure DevOps ${label} request failed: HTTP ${response.status}`
                + `${detail ? ` ${detail}` : ""}`,
            );
        }
        return response.json();
    }

    async observePullRequestApproval(
        rawTarget: unknown,
    ): Promise<AzureDevOpsPullRequestApprovalSnapshot | null> {
        const target = parseAzureDevOpsPullRequestApprovalTarget(rawTarget);
        const authorization = await this.authorization();
        const pullRequestBody = await this.getJson(
            pullRequestEndpoint(target),
            authorization,
            "pull-request",
            true,
        );
        if (pullRequestBody === null) return null;
        const pullRequest = parsePullRequest(pullRequestBody, target);
        const [reviewersBody, policiesBody] = await Promise.all([
            this.getJson(
                pullRequestEndpoint(target, "/reviewers"),
                authorization,
                "pull-request reviewers",
            ),
            this.getJson(
                policyEvaluationsEndpoint(target, pullRequest.projectId),
                authorization,
                "policy evaluations",
            ),
        ]);
        const currentPullRequestBody = await this.getJson(
            pullRequestEndpoint(target),
            authorization,
            "pull-request consistency",
            true,
        );
        if (currentPullRequestBody === null) return null;
        return {
            pullRequest: parsePullRequest(currentPullRequestBody, target),
            reviewers: parseReviewers(reviewersBody),
            policies: parsePolicyEvaluations(policiesBody),
        };
    }

    async observePullRequestCompletion(
        rawTarget: unknown,
    ): Promise<AzureDevOpsPullRequestCompletionSnapshot | null> {
        const target = parseAzureDevOpsPullRequestApprovalTarget(rawTarget);
        const authorization = await this.authorization();
        const pullRequestBody = await this.getJson(
            pullRequestEndpoint(target),
            authorization,
            "pull-request",
            true,
        );
        if (pullRequestBody === null) return null;
        return { pullRequest: parsePullRequest(pullRequestBody, target) };
    }
}

function approvalCursor(snapshot: AzureDevOpsPullRequestApprovalSnapshot): string {
    return JSON.stringify({
        sourceCommit: snapshot.pullRequest.sourceCommit,
        updatedAt: snapshot.pullRequest.lastContentUpdatedDate,
        reviewers: snapshot.reviewers
            .map((reviewer) => [reviewer.id, reviewer.vote])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
        policies: snapshot.policies
            .map((policy) => [policy.evaluationId, policy.status])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
    });
}

function applyConditionOverrides(
    snapshot: AzureDevOpsPullRequestApprovalSnapshot,
    overrides: readonly string[] | undefined,
): void {
    if (!overrides || overrides.length === 0) return;
    const keys = new Set(overrides);
    for (const policy of snapshot.policies) {
        if (policy.configurationId !== null && keys.has(`policy:${policy.configurationId}`)) {
            policy.status = "approved";
        }
    }
    for (const reviewer of snapshot.reviewers) {
        if (keys.has(`reviewer:${reviewer.id}`)) {
            reviewer.vote = 10;
        }
    }
}

function observationEvidence(
    target: AzureDevOpsPullRequestApprovalTarget,
    snapshot: AzureDevOpsPullRequestApprovalSnapshot,
    observedAt: string,
): Record<string, unknown> {
    const requiredReviewers = snapshot.reviewers
        .filter((reviewer) => reviewer.isRequired)
        .map((reviewer) => ({
            id: reviewer.id,
            displayName: reviewer.displayName,
            uniqueName: reviewer.uniqueName,
            vote: reviewer.vote,
            approved: reviewer.vote >= 5,
        }));
    const policies = snapshot.policies.map((policy) => ({
        evaluationId: policy.evaluationId,
        configurationId: policy.configurationId,
        typeId: policy.typeId,
        typeName: policy.typeName,
        displayName: policy.displayName,
        isEnabled: policy.isEnabled,
        isBlocking: policy.isBlocking,
        status: policy.status,
        startedDate: policy.startedDate,
        completedDate: policy.completedDate,
    }));
    return {
        provider: AZURE_DEVOPS_JOB_WAIT_PROVIDER,
        kind: AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND,
        organization: target.organization,
        project: target.project,
        repositoryId: target.repositoryId,
        pullRequestId: target.pullRequestId,
        pullRequestStatus: snapshot.pullRequest.status,
        sourceRefName: snapshot.pullRequest.sourceRefName,
        targetRefName: snapshot.pullRequest.targetRefName,
        expectedSourceCommit: target.expectedSourceCommit,
        sourceCommit: snapshot.pullRequest.sourceCommit,
        requiredReviewers,
        policies,
        observedAt,
    };
}

export class AzureDevOpsPullRequestApprovalObserver implements JobWaitObserver {
    readonly provider = AZURE_DEVOPS_JOB_WAIT_PROVIDER;
    readonly kind = AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND;

    constructor(
        private readonly client: AzureDevOpsPullRequestClient,
        private readonly authorizer: AzureDevOpsPullRequestTargetAuthorizer,
    ) {}

    async observe(input: {
        wait: JobWaitRow;
        operation: JobExternalOperationRow;
    }): Promise<JobWaitObservation> {
        const target = parseAzureDevOpsPullRequestApprovalTarget(input.operation.request);
        await this.authorizer.authorize({ ...input, target });
        const snapshot = await this.client.observePullRequestApproval(target);
        const observedAt = new Date().toISOString();
        if (!snapshot) {
            const evidence = { ...target, observedAt, reason: "pull_request_not_found" };
            return {
                disposition: "failed",
                observation: evidence,
                evidence,
                result: { approved: false, reason: "pull_request_not_found" },
                error: "Azure DevOps pull request was not found",
            };
        }

        applyConditionOverrides(snapshot, input.wait.conditionOverrides);
        const evidence = observationEvidence(target, snapshot, observedAt);
        const cursor = approvalCursor(snapshot);
        if (snapshot.pullRequest.sourceCommit !== target.expectedSourceCommit) {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "source_commit_changed" },
                cursor,
                evidence,
                result: {
                    approved: false,
                    reason: "source_commit_changed",
                    expectedSourceCommit: target.expectedSourceCommit,
                    sourceCommit: snapshot.pullRequest.sourceCommit,
                },
                error: "Azure DevOps pull request source commit changed",
            };
        }
        if (snapshot.pullRequest.status === "abandoned") {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "pull_request_abandoned" },
                cursor,
                evidence,
                result: { approved: false, reason: "pull_request_abandoned" },
                error: "Azure DevOps pull request was abandoned",
            };
        }
        if (!["active", "completed"].includes(snapshot.pullRequest.status)) {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "unsupported_pull_request_status" },
                cursor,
                evidence,
                result: {
                    approved: false,
                    reason: "unsupported_pull_request_status",
                    status: snapshot.pullRequest.status,
                },
                error: `Azure DevOps pull request has unsupported status: ${snapshot.pullRequest.status}`,
            };
        }

        const pendingReviewers = snapshot.reviewers.filter(
            (reviewer) => reviewer.isRequired && reviewer.vote < 5,
        );
        const pendingPolicies = snapshot.policies.filter(
            (policy) => (
                policy.isEnabled
                && policy.isBlocking
                && policy.status !== "approved"
                && policy.status !== "notApplicable"
            ),
        );
        if (pendingReviewers.length > 0 || pendingPolicies.length > 0) {
            return {
                disposition: "pending",
                observation: {
                    ...evidence,
                    ready: false,
                    pendingReviewerIds: pendingReviewers.map((reviewer) => reviewer.id),
                    pendingPolicyEvaluationIds: pendingPolicies.map(
                        (policy) => policy.evaluationId,
                    ),
                },
                cursor,
            };
        }

        const result = {
            approved: true,
            organization: target.organization,
            project: target.project,
            repositoryId: target.repositoryId,
            pullRequestId: target.pullRequestId,
            sourceCommit: snapshot.pullRequest.sourceCommit,
            targetRefName: snapshot.pullRequest.targetRefName,
            observedAt,
        };
        return {
            disposition: "satisfied",
            observation: { ...evidence, ready: true },
            cursor,
            evidence,
            result,
            error: null,
        };
    }
}

export type AzureDevOpsPullRequestEventStore = Pick<
    SessionCatalog,
    "accelerateJobWaitChecksByTarget"
>;

function completionCursor(snapshot: AzureDevOpsPullRequestCompletionSnapshot): string {
    return JSON.stringify({
        status: snapshot.pullRequest.status,
        sourceCommit: snapshot.pullRequest.sourceCommit,
        mergeCommit: snapshot.pullRequest.mergeCommit,
        closedDate: snapshot.pullRequest.closedDate,
    });
}

function completionEvidence(
    target: AzureDevOpsPullRequestApprovalTarget,
    snapshot: AzureDevOpsPullRequestCompletionSnapshot,
    observedAt: string,
): Record<string, unknown> {
    const pullRequest = snapshot.pullRequest;
    const completedBy = pullRequest.closedById
        || pullRequest.closedByUniqueName
        || pullRequest.closedByDisplayName
        ? {
            id: pullRequest.closedById,
            displayName: pullRequest.closedByDisplayName,
            uniqueName: pullRequest.closedByUniqueName,
        }
        : null;
    return {
        provider: AZURE_DEVOPS_JOB_WAIT_PROVIDER,
        kind: AZURE_DEVOPS_PULL_REQUEST_COMPLETION_KIND,
        organization: target.organization,
        project: target.project,
        repositoryId: target.repositoryId,
        pullRequestId: target.pullRequestId,
        pullRequestStatus: pullRequest.status,
        sourceRefName: pullRequest.sourceRefName,
        targetRefName: pullRequest.targetRefName,
        expectedSourceCommit: target.expectedSourceCommit,
        sourceCommit: pullRequest.sourceCommit,
        mergeCommit: pullRequest.mergeCommit,
        mergeStatus: pullRequest.mergeStatus,
        completedBy,
        completedDate: pullRequest.closedDate,
        observedAt,
    };
}

export class AzureDevOpsPullRequestCompletionObserver implements JobWaitObserver {
    readonly provider = AZURE_DEVOPS_JOB_WAIT_PROVIDER;
    readonly kind = AZURE_DEVOPS_PULL_REQUEST_COMPLETION_KIND;

    constructor(
        private readonly client: Pick<
            AzureDevOpsPullRequestClient,
            "observePullRequestCompletion"
        >,
        private readonly authorizer: AzureDevOpsPullRequestTargetAuthorizer,
    ) {}

    async observe(input: {
        wait: JobWaitRow;
        operation: JobExternalOperationRow;
    }): Promise<JobWaitObservation> {
        const target = parseAzureDevOpsPullRequestApprovalTarget(input.operation.request);
        await this.authorizer.authorize({ ...input, target });
        const snapshot = await this.client.observePullRequestCompletion(target);
        const observedAt = new Date().toISOString();
        if (!snapshot) {
            const evidence = { ...target, observedAt, reason: "pull_request_not_found" };
            return {
                disposition: "failed",
                observation: evidence,
                evidence,
                result: { completed: false, reason: "pull_request_not_found" },
                error: "Azure DevOps pull request was not found",
            };
        }

        const evidence = completionEvidence(target, snapshot, observedAt);
        const cursor = completionCursor(snapshot);
        const status = snapshot.pullRequest.status;
        if (status === "abandoned") {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "pull_request_abandoned" },
                cursor,
                evidence,
                result: { completed: false, reason: "pull_request_abandoned" },
                error: "Azure DevOps pull request was abandoned",
            };
        }
        if (status !== "active" && status !== "completed") {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "unsupported_pull_request_status" },
                cursor,
                evidence,
                result: {
                    completed: false,
                    reason: "unsupported_pull_request_status",
                    status,
                },
                error: `Azure DevOps pull request has unsupported status: ${status}`,
            };
        }
        if (snapshot.pullRequest.sourceCommit !== target.expectedSourceCommit) {
            return {
                disposition: "failed",
                observation: { ...evidence, reason: "source_commit_changed" },
                cursor,
                evidence,
                result: {
                    completed: false,
                    reason: "source_commit_changed",
                    expectedSourceCommit: target.expectedSourceCommit,
                    sourceCommit: snapshot.pullRequest.sourceCommit,
                },
                error: "Azure DevOps pull request source commit changed",
            };
        }
        if (status === "active") {
            return {
                disposition: "pending",
                observation: { ...evidence, completed: false },
                cursor,
            };
        }

        const result = {
            completed: true,
            organization: target.organization,
            project: target.project,
            repositoryId: target.repositoryId,
            pullRequestId: target.pullRequestId,
            sourceCommit: snapshot.pullRequest.sourceCommit,
            mergeCommit: snapshot.pullRequest.mergeCommit,
            targetRefName: snapshot.pullRequest.targetRefName,
            completedDate: snapshot.pullRequest.closedDate,
            observedAt,
        };
        return {
            disposition: "satisfied",
            observation: { ...evidence, completed: true },
            cursor,
            evidence,
            result,
            error: null,
        };
    }
}

export async function accelerateAzureDevOpsPullRequestApprovalWaits(
    store: AzureDevOpsPullRequestEventStore,
    rawIdentity: unknown,
    checkAt = new Date(),
): Promise<number> {
    const identity = parseAzureDevOpsPullRequestIdentity(rawIdentity);
    return store.accelerateJobWaitChecksByTarget(
        AZURE_DEVOPS_JOB_WAIT_PROVIDER,
        AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND,
        azureDevOpsPullRequestResourceKey(identity),
        checkAt,
    );
}

export async function accelerateAzureDevOpsPullRequestCompletionWaits(
    store: AzureDevOpsPullRequestEventStore,
    rawIdentity: unknown,
    checkAt = new Date(),
): Promise<number> {
    const identity = parseAzureDevOpsPullRequestIdentity(rawIdentity);
    return store.accelerateJobWaitChecksByTarget(
        AZURE_DEVOPS_JOB_WAIT_PROVIDER,
        AZURE_DEVOPS_PULL_REQUEST_COMPLETION_KIND,
        azureDevOpsPullRequestResourceKey(identity),
        checkAt,
    );
}
