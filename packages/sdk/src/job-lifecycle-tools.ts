import { defineTool, type Tool } from "@github/copilot-sdk";
import type { SessionCatalog } from "./cms.js";

export function createJobLifecycleTools(
    catalog: Pick<
        SessionCatalog,
        "completeJobState" | "startJobExternalOperation" | "getJobExternalOperation"
    >,
): Tool<any>[] {
    return [
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
                        enum: ["mock"],
                        description: "External operation provider. The deterministic demonstration provider is mock.",
                    },
                    kind: {
                        type: "string",
                        description: "Stable lowercase operation kind, such as pvs, build, deployment, or pull_request.",
                    },
                    operationKey: {
                        type: "string",
                        description: "Optional stable key when this state needs more than one operation of the same kind.",
                    },
                    request: {
                        type: "object",
                        description:
                            "Provider request. For mock: delayMs, outcome (succeeded or failed), result, evidence, and error are supported.",
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
                    request?: Record<string, unknown>;
                },
                invocation: any,
            ) => {
                const sessionId = invocation?.durableSessionId;
                if (!sessionId) {
                    throw new Error("start_external_operation requires a durable session context");
                }
                if (params.provider !== "mock") {
                    throw new Error(`Unsupported external operation provider: ${params.provider}`);
                }
                const rawDelay = Number(params.request?.delayMs ?? 1_000);
                if (!Number.isFinite(rawDelay) || rawDelay < 0 || rawDelay > 300_000) {
                    throw new Error("Mock external operation delayMs must be between 0 and 300000");
                }
                const outcome = params.request?.outcome;
                if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
                    throw new Error("Mock external operation outcome must be succeeded or failed");
                }
                const operation = await catalog.startJobExternalOperation({
                    sessionId,
                    provider: params.provider,
                    kind: params.kind,
                    operationKey: params.operationKey,
                    request: params.request,
                    nextPollAt: new Date(Date.now() + rawDelay),
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
