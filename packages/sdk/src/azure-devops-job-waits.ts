import { createHash } from "node:crypto";

export const AZURE_DEVOPS_JOB_WAIT_PROVIDER = "azure_devops";
export const AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND = "pull_request_approval";

export interface AzureDevOpsPullRequestIdentity {
    organization: string;
    project: string;
    repositoryId: string;
    pullRequestId: number;
}

export interface AzureDevOpsPullRequestApprovalTarget extends AzureDevOpsPullRequestIdentity {
    expectedSourceCommit: string;
    resourceKey: string;
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
    };
}

export function azureDevOpsPullRequestApprovalOperationKey(
    target: AzureDevOpsPullRequestApprovalTarget,
): string {
    const targetHash = createHash("sha256")
        .update(target.resourceKey)
        .update("\0")
        .update(target.expectedSourceCommit)
        .digest("hex")
        .slice(0, 24);
    return `approval:pull-request:${target.pullRequestId}:${targetHash}`;
}
