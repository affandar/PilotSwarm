import { defineTool, type Tool } from "@github/copilot-sdk";
import type { SessionCatalog, SessionEvent } from "./cms.js";
import {
    AZURE_DEVOPS_JOB_WAIT_PROVIDER,
    AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND,
    azureDevOpsPullRequestApprovalOperationKey,
    parseAzureDevOpsPullRequestApprovalTarget,
} from "./azure-devops-job-waits.js";

const MAX_EVENT_DATA_BYTES = 4 * 1024;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_JOURNAL_SUMMARY_BYTES = 8 * 1024;

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
    let bytes = 0;
    let result = "";
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (bytes + characterBytes > maxBytes - 3) break;
        result += character;
        bytes += characterBytes;
    }
    return { value: `${result}...`, truncated: true };
}

function serializeSourceSessionEvents(
    events: readonly SessionEvent[],
    responseBase: Record<string, unknown>,
): {
    events: Array<{
        seq: number;
        eventType: string;
        createdAt: string;
        workerNodeId?: string;
        data?: unknown;
        dataTruncated?: boolean;
    }>;
    truncated: boolean;
} {
    const serialized = [];
    let truncated = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        let data = event.data;
        let dataTruncated = false;
        if (data !== undefined) {
            try {
                const text = JSON.stringify(data);
                if (typeof text !== "string") {
                    data = String(data);
                    dataTruncated = true;
                } else {
                    const truncatedData = truncateUtf8(text, MAX_EVENT_DATA_BYTES);
                    if (truncatedData.truncated) {
                        data = truncatedData.value;
                        dataTruncated = true;
                    }
                }
            } catch {
                data = "[unserializable]";
                dataTruncated = true;
            }
        }
        const item = {
            seq: event.seq,
            eventType: event.eventType,
            createdAt: event.createdAt instanceof Date
                ? event.createdAt.toISOString()
                : String(event.createdAt),
            ...(event.workerNodeId ? { workerNodeId: event.workerNodeId } : {}),
            ...(data !== undefined ? { data } : {}),
            ...(dataTruncated ? { dataTruncated: true } : {}),
        };
        const candidate = [item, ...serialized];
        const candidateResponse = {
            ...responseBase,
            events: candidate,
            previousCursor: candidate[0]?.seq ?? null,
            hasMore: false,
        };
        if (Buffer.byteLength(JSON.stringify(candidateResponse), "utf8") > MAX_CONTEXT_BYTES) {
            truncated = true;
            break;
        }
        serialized.unshift(item);
    }
    return { events: serialized, truncated };
}

export function createJobLifecycleTools(
    catalog: Pick<
        SessionCatalog,
        | "completeJobState"
        | "startJobExternalOperation"
        | "getJobExternalOperation"
        | "readJobSourceSession"
    >,
): Tool<any>[] {
    return [
        defineTool("read_job_source_session", {
            description:
                "Read durable execution events from a prior JobSession referenced by the current Job journal. "
                + "Use the Session ID shown in the durable Job journal when its summary does not contain enough context. "
                + "The server permits only source sessions belonging to the same Job.",
            parameters: {
                type: "object" as const,
                properties: {
                    sessionId: {
                        type: "string",
                        description: "Prior source JobSession ID shown in the Job journal.",
                    },
                    beforeSeq: {
                        type: "number",
                        description: "Optional cursor returned by a previous page to read older events.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum events to return, from 1 through 50. Default 20.",
                    },
                },
                required: ["sessionId"],
            },
            handler: async (
                params: { sessionId: string; beforeSeq?: number; limit?: number },
                invocation: any,
            ) => {
                const currentSessionId = invocation?.durableSessionId;
                if (!currentSessionId) {
                    throw new Error("read_job_source_session requires a durable session context");
                }
                const sourceSessionId = params.sessionId?.trim();
                if (!sourceSessionId) throw new Error("read_job_source_session requires sessionId");
                const context = await catalog.readJobSourceSession(
                    currentSessionId,
                    sourceSessionId,
                    params.beforeSeq,
                    params.limit,
                );
                if (!context) {
                    throw new Error(
                        `Source session ${sourceSessionId} is not referenced by the current Job journal`,
                    );
                }
                const summary = truncateUtf8(
                    context.journalEntry.summary,
                    MAX_JOURNAL_SUMMARY_BYTES,
                );
                const responseBase = {
                    sourceSessionId,
                    journal: {
                        sequence: context.journalEntry.sequence,
                        fromState: context.journalEntry.fromState,
                        toState: context.journalEntry.toState,
                        outcome: context.journalEntry.outcome,
                        summary: summary.value,
                        ...(summary.truncated ? { summaryTruncated: true } : {}),
                        transitionedAt: context.journalEntry.transitionedAt.toISOString(),
                    },
                };
                const page = serializeSourceSessionEvents(context.events, responseBase);
                return JSON.stringify({
                    ...responseBase,
                    events: page.events,
                    previousCursor: page.events[0]?.seq ?? null,
                    hasMore: context.hasMore || page.truncated,
                });
            },
        }),
        defineTool("start_external_operation", {
            description:
                "Start or recover a platform-owned external operation for the current Job state. "
                + "The infrastructure creates the durable operation identity and system-wait signal key. "
                + "Repeated calls with the same provider, kind, and operationKey return the same operation. "
                + "After starting a pending operation, call system_wait with the returned signalKey.",
            parameters: {
                type: "object" as const,
                properties: {
                    provider: {
                        type: "string",
                        enum: ["mock", AZURE_DEVOPS_JOB_WAIT_PROVIDER],
                        description:
                            "External operation provider. Use mock for deterministic demonstrations "
                            + "or azure_devops for production pull-request observation.",
                    },
                    kind: {
                        type: "string",
                        description: "Stable lowercase operation kind, such as pvs, build, deployment, or pull_request.",
                    },
                    operationKey: {
                        type: "string",
                        description: "Optional stable key when this state needs more than one operation of the same kind.",
                    },
                    detectionMode: {
                        type: "string",
                        enum: ["poll", "event", "hybrid"],
                        description:
                            "How the condition is detected. Hybrid events accelerate a check while polling guarantees reconciliation.",
                    },
                    deadlineSeconds: {
                        type: "number",
                        description:
                            "Optional deadline in seconds. If the condition is still pending at the deadline, the wait times out.",
                    },
                    request: {
                        type: "object",
                        description:
                            "Provider request. For mock: delayMs, outcome, result, evidence, and error. "
                            + "For Azure DevOps pull-request approval: organization, project, repositoryId, "
                            + "pullRequestId, and expectedSourceCommit.",
                        additionalProperties: true,
                    },
                },
                required: ["provider", "kind"],
            },
            handler: async (
                params: {
                    provider: string;
                    kind: string;
                    operationKey?: string;
                    detectionMode?: "poll" | "event" | "hybrid";
                    deadlineSeconds?: number;
                    request?: Record<string, unknown>;
                },
                invocation: any,
            ) => {
                const sessionId = invocation?.durableSessionId;
                if (!sessionId) {
                    throw new Error("start_external_operation requires a durable session context");
                }
                if (params.provider !== "mock"
                    && params.provider !== AZURE_DEVOPS_JOB_WAIT_PROVIDER) {
                    throw new Error(`Unsupported external operation provider: ${params.provider}`);
                }
                const deadlineSeconds = params.deadlineSeconds;
                if (deadlineSeconds !== undefined
                    && (!Number.isFinite(deadlineSeconds)
                        || deadlineSeconds <= 0
                        || deadlineSeconds > 604_800)) {
                    throw new Error("External operation deadlineSeconds must be between 1 and 604800");
                }
                let request = params.request;
                let operationKey = params.operationKey;
                let nextPollAt = new Date();
                if (params.provider === "mock") {
                    const rawDelay = Number(params.request?.delayMs ?? 1_000);
                    if (!Number.isFinite(rawDelay) || rawDelay < 0 || rawDelay > 300_000) {
                        throw new Error("Mock external operation delayMs must be between 0 and 300000");
                    }
                    const outcome = params.request?.outcome;
                    if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
                        throw new Error("Mock external operation outcome must be succeeded or failed");
                    }
                    nextPollAt = new Date(Date.now() + rawDelay);
                } else {
                    if (params.kind !== AZURE_DEVOPS_PULL_REQUEST_APPROVAL_KIND) {
                        throw new Error(
                            "Azure DevOps currently supports only pull_request_approval operations",
                        );
                    }
                    const target = parseAzureDevOpsPullRequestApprovalTarget(params.request);
                    request = { ...target };
                    operationKey ??= azureDevOpsPullRequestApprovalOperationKey(target);
                }
                const operation = await catalog.startJobExternalOperation({
                    sessionId,
                    provider: params.provider,
                    kind: params.kind,
                    operationKey,
                    request,
                    nextPollAt,
                    detectionMode: params.detectionMode,
                    deadlineAt: deadlineSeconds === undefined
                        ? undefined
                        : new Date(Date.now() + deadlineSeconds * 1_000),
                });
                return JSON.stringify({
                    operationId: operation.operationId,
                    correlationId: operation.correlationId,
                    signalKey: operation.signalKey,
                    provider: operation.provider,
                    kind: operation.kind,
                    status: operation.status,
                    signalStatus: operation.signalStatus,
                    resumed: operation.status !== "pending",
                });
            },
        }),
        defineTool("get_external_operation", {
            description:
                "Read the durable result and evidence for an external operation started by the current Job state.",
            parameters: {
                type: "object" as const,
                properties: {
                    operationId: {
                        type: "string",
                        description: "Infrastructure-generated operation ID returned by start_external_operation.",
                    },
                },
                required: ["operationId"],
            },
            handler: async (
                params: { operationId: string },
                invocation: any,
            ) => {
                const sessionId = invocation?.durableSessionId;
                if (!sessionId) {
                    throw new Error("get_external_operation requires a durable session context");
                }
                const operation = await catalog.getJobExternalOperation(sessionId, params.operationId);
                if (!operation) throw new Error(`External operation not found: ${params.operationId}`);
                return JSON.stringify({
                    operationId: operation.operationId,
                    correlationId: operation.correlationId,
                    signalKey: operation.signalKey,
                    provider: operation.provider,
                    kind: operation.kind,
                    status: operation.status,
                    signalStatus: operation.signalStatus,
                    result: operation.result,
                    evidence: operation.evidence,
                    error: operation.error,
                    completedAt: operation.completedAt?.toISOString() ?? null,
                    signalDeliveredAt: operation.signalDeliveredAt?.toISOString() ?? null,
                });
            },
        }),
        Object.assign(defineTool("complete_state", {
            description:
                "Complete the current Job lifecycle state and durably record its handoff summary. "
                + "For nonterminal states, outcome must be one of the possible next states in the current instructions. "
                + "For terminal states, omit outcome.",
            parameters: {
                type: "object" as const,
                properties: {
                    outcome: {
                        type: "string",
                        description: "The selected possible next state. Omit for a terminal state.",
                    },
                    summary: {
                        type: "string",
                        description:
                            "Required durable handoff describing the outcome, relevant evidence, and details needed by the next state.",
                    },
                },
                required: ["summary"],
            },
            handler: async (
                params: { outcome?: string; summary: string },
                invocation: any,
            ) => {
                const sessionId = invocation?.durableSessionId;
                if (!sessionId) throw new Error("complete_state requires a durable session context");
                const entry = await catalog.completeJobState({
                    sessionId,
                    outcome: params.outcome,
                    summary: params.summary,
                });
                return JSON.stringify({
                    completed: true,
                    jobId: entry.jobId,
                    fromState: entry.fromState,
                    toState: entry.toState,
                    outcome: entry.outcome,
                    journalSequence: entry.sequence,
                });
            },
        }), {
            pilotswarmTerminalTurnBoundary: true,
        }),
    ];
}
