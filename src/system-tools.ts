import { defineTool, type Tool, type CopilotSession } from "@github/copilot-sdk";
import type { TurnResult } from "./types.js";

/**
 * State captured during a sendAndWait() call.
 * The wait tool sets pendingWait and aborts the session.
 * @internal
 */
export interface TurnState {
    pendingWait: { seconds: number; reason: string } | null;
    pendingInput: { question: string; choices?: string[]; allowFreeform?: boolean } | null;
    session: CopilotSession | null;
    waitThreshold: number;
}

/**
 * Creates the system tools injected into every agent session.
 * The wait tool is the escape hatch from the SDK's inner loop
 * back to the orchestration for durable timers.
 * @internal
 */
export function createSystemTools(turnState: TurnState): Tool<any>[] {
    const waitTool = defineTool("wait", {
        description:
            "REQUIRED: The ONLY way to wait, pause, sleep, or delay. " +
            "You MUST call this tool whenever you need to wait, pause, delay, " +
            "poll, check back later, schedule a future action, or implement " +
            "any recurring/periodic task. NEVER use bash sleep, setTimeout, " +
            "setInterval, cron, or any other timing mechanism. This tool " +
            "enables durable waiting that survives process restarts.",
        parameters: {
            type: "object",
            properties: {
                seconds: {
                    type: "number",
                    description: "How long to wait in seconds",
                },
                reason: {
                    type: "string",
                    description: "Why you're waiting",
                },
            },
            required: ["seconds"],
        },
        handler: async (args: { seconds: number; reason?: string }) => {
            const reason = args.reason ?? "unspecified";

            if (args.seconds <= turnState.waitThreshold) {
                // Short wait — sleep in-process, return normally
                await new Promise((r) =>
                    setTimeout(r, args.seconds * 1000)
                );
                return `Waited for ${args.seconds} seconds. The wait is complete, you may continue.`;
            }

            // Long wait — capture and abort for durable timer
            turnState.pendingWait = {
                seconds: args.seconds,
                reason,
            };

            if (turnState.session) {
                turnState.session.abort();
            }

            // This return likely won't reach the LLM since abort kills sendAndWait
            return "aborted";
        },
    });

    return [waitTool];
}

/**
 * Merge user-provided tools with system tools.
 * System tools are added last so they don't conflict.
 * @internal
 */
export function mergeTools(
    userTools: Tool<any>[],
    systemTools: Tool<any>[]
): Tool<any>[] {
    const userNames = new Set(userTools.map((t) => t.name));
    const filtered = systemTools.filter((t) => !userNames.has(t.name));
    return [...userTools, ...filtered];
}
