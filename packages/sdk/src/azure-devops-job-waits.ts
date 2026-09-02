import { createHash } from "node:crypto";

export const AZURE_DEVOPS_JOB_WAIT_PROVIDER = "azure_devops";
export const AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND = "pull_request_approval";
export const AZURE_DEVOPS_PULL_REQUEST_COMPLETION_KIND = "pull_request_completion";

export interface AzureDevOpsPullRequestIdentity {
    organization: string;
    project: string;
    repositoryId: string;
    pullRequestId: number;
}

export type AzureDevOpsCodeReviewRecommendation = "approve" | "approve_with_comments";

/**
 * Heterogeneous, declarative conditions that satisfy a single `pull_request_approval`
 * watcher. The gate is satisfied only when every declared condition holds against the
 * current source commit. Different Job states declare different condition sets against the
 * same watcher kind rather than introducing a new kind per gate flavor.
 */
export interface AzureDevOpsApprovalConditions {
    /** Every required human reviewer must vote approve (>= 5). */
    requiredReviewers: boolean;
    /** Every enabled, blocking branch policy must be approved or not applicable. */
    requireAllBlockingPolicies: boolean;
    /** These named branch policies (matched by displayName, case-insensitively) must pass. */
    requiredPolicyDisplayNames: string[];
    /**
     * When set, a Code Review Agent overall-assessment comment on the current PR iteration
     * must carry one of these recommendations. `null` means the code-review comment is not
     * consulted.
     */
    codeReviewRecommendation: AzureDevOpsCodeReviewRecommendation[] | null;
}

export interface AzureDevOpsPullRequestApprovalTarget extends AzureDevOpsPullRequestIdentity {
    expectedSourceCommit: string;
    resourceKey: string;
    conditions: AzureDevOpsApprovalConditions;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function requiredString(value: unknown, label: string): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) throw new Error(`Azure DevOps pull-request target requires ${label}`);
    if (normalized.length > 256) {
        throw new Error(`Azure DevOps pull-request target ${label} is too long`);
    }
    return normalized;
}

export function normalizeAzureDevOpsOrganization(value: unknown): string {
    const organization = requiredString(value, "organization");
    try {
        const url = new URL(organization);
        const hostname = url.hostname.toLowerCase();
        if (hostname === "dev.azure.com") {
            const name = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
            if (name) return name;
        }
        if (hostname.endsWith(".visualstudio.com")) {
            return hostname.slice(0, -".visualstudio.com".length);
        }
    } catch {
        // Plain organization names are normalized below.
    }
    if (/[/\\?#]/.test(organization)) {
        throw new Error("Azure DevOps pull-request target organization is invalid");
    }
    return organization;
}

export function parseAzureDevOpsPullRequestIdentity(
    value: unknown,
): AzureDevOpsPullRequestIdentity {
    const input = record(value);
    const organization = normalizeAzureDevOpsOrganization(input.organization);
    const project = requiredString(input.project, "project");
    const repositoryId = requiredString(input.repositoryId, "repositoryId");
    if (/[/\\?#]/.test(project) || /[/\\?#]/.test(repositoryId)) {
        throw new Error("Azure DevOps pull-request target project or repositoryId is invalid");
    }
    const pullRequestId = Number(input.pullRequestId);
    if (!Number.isInteger(pullRequestId) || pullRequestId <= 0) {
        throw new Error("Azure DevOps pull-request target pullRequestId must be a positive integer");
    }
    return { organization, project, repositoryId, pullRequestId };
}

export function azureDevOpsPullRequestResourceKey(
    identity: AzureDevOpsPullRequestIdentity,
): string {
    const components = [
        identity.organization,
        identity.project,
        identity.repositoryId,
        String(identity.pullRequestId),
    ].map((component) => encodeURIComponent(component.trim().toLowerCase()));
    return `azure_devops:pull_request:${components.join(":")}`;
}

function normalizeCodeReviewRecommendation(value: unknown): AzureDevOpsCodeReviewRecommendation {
    const raw = typeof value === "string"
        ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
        : "";
    if (raw === "approve") return "approve";
    if (raw === "approve_with_comments") return "approve_with_comments";
    throw new Error(
        `Azure DevOps approval condition has an invalid code-review recommendation: ${String(value)}`,
    );
}

function parseConditionStringArray(value: unknown, label: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Azure DevOps approval condition ${label} must be an array of strings`);
    }
    return value.map((entry) => requiredString(entry, `${label} entry`));
}

export function parseAzureDevOpsApprovalConditions(value: unknown): AzureDevOpsApprovalConditions {
    if (value === undefined || value === null) {
        return {
            requiredReviewers: true,
            requireAllBlockingPolicies: true,
            requiredPolicyDisplayNames: [],
            codeReviewRecommendation: null,
        };
    }
    const input = record(value);
    const recommendationRaw = input.codeReviewRecommendation;
    let codeReviewRecommendation: AzureDevOpsCodeReviewRecommendation[] | null = null;
    if (recommendationRaw !== undefined && recommendationRaw !== null) {
        if (!Array.isArray(recommendationRaw) || recommendationRaw.length === 0) {
            throw new Error(
                "Azure DevOps approval condition codeReviewRecommendation must be a non-empty array",
            );
        }
        codeReviewRecommendation = recommendationRaw.map(normalizeCodeReviewRecommendation);
    }
    const conditions: AzureDevOpsApprovalConditions = {
        requiredReviewers: input.requiredReviewers === true,
        requireAllBlockingPolicies: input.requireAllBlockingPolicies === true,
        requiredPolicyDisplayNames: parseConditionStringArray(
            input.requiredPolicyDisplayNames,
            "requiredPolicyDisplayNames",
        ),
        codeReviewRecommendation,
    };
    if (!conditions.requiredReviewers
        && !conditions.requireAllBlockingPolicies
        && conditions.requiredPolicyDisplayNames.length === 0
        && conditions.codeReviewRecommendation === null) {
        throw new Error(
            "Azure DevOps approval conditions must declare at least one satisfaction condition",
        );
    }
    return conditions;
}

export function parseAzureDevOpsPullRequestApprovalTarget(
    value: unknown,
): AzureDevOpsPullRequestApprovalTarget {
    const input = record(value);
    const identity = parseAzureDevOpsPullRequestIdentity(input);
    const expectedSourceCommit = requiredString(
        input.expectedSourceCommit,
        "expectedSourceCommit",
    ).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit)) {
        throw new Error(
            "Azure DevOps pull-request target expectedSourceCommit must be a 40-character Git commit",
        );
    }
    return {
        ...identity,
        expectedSourceCommit,
        resourceKey: azureDevOpsPullRequestResourceKey(identity),
        conditions: parseAzureDevOpsApprovalConditions(input.conditions),
    };
}

export function azureDevOpsPullRequestApprovalOperationKey(
    target: AzureDevOpsPullRequestApprovalTarget,
): string {
    return `approval:pull-request:${target.pullRequestId}:${pullRequestTargetHash(target)}`;
}

export function azureDevOpsPullRequestCompletionOperationKey(
    target: AzureDevOpsPullRequestApprovalTarget,
): string {
    return `completion:pull-request:${target.pullRequestId}:${pullRequestTargetHash(target)}`;
}

function pullRequestTargetHash(target: AzureDevOpsPullRequestApprovalTarget): string {
    return createHash("sha256")
        .update(target.resourceKey)
        .update("\0")
        .update(target.expectedSourceCommit)
        .digest("hex")
        .slice(0, 24);
}
