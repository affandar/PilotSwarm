import { defineTool, type Tool } from "@github/copilot-sdk";
import type { SessionCatalog } from "./cms.js";

export function createJobLifecycleTools(
    catalog: Pick<SessionCatalog, "completeJobState">,
): Tool<any>[] {
    return [
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
