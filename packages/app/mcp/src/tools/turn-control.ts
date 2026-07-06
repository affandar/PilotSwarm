import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Turn- and queue-level session control (proposal G3) — finer levers than
 * abort_session's whole-session cancel:
 *
 *   stop_turn               abort the in-flight turn, keep the session
 *   complete_session        mark done (distinct from cancelled)
 *   cancel_pending_messages drop queued messages by client message id
 *   send_session_event      inject a custom event into the session
 */
export function registerTurnControlTools(server: McpServer, ctx: ServerContext) {
    async function requireSession(session_id: string) {
        const existing = await ctx.mgmt.getSession(session_id);
        return existing ?? null;
    }

    server.registerTool(
        "stop_turn",
        {
            title: "Stop Turn",
            description:
                "Abort the in-flight turn of a running PilotSwarm session without cancelling the session — it stays "
                + "alive and accepts new messages. Use abort_session only when the whole session should end.",
            inputSchema: {
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session whose current turn to stop"),
                reason: z.string().optional().describe("Optional reason, surfaced to the session"),
                timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the turn to stop"),
            },
        },
        withToolErrors(async ({ session_id, reason, timeout_ms }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            const result = await ctx.mgmt.stopSessionTurn(session_id, { reason, timeoutMs: timeout_ms });
            return jsonResult({ stopped: true, ...(result && typeof result === "object" ? result : {}) });
        }),
    );

    server.registerTool(
        "complete_session",
        {
            title: "Complete Session",
            description:
                "Mark a PilotSwarm session completed (a successful terminal state — distinct from abort_session's "
                + "cancelled). Use when the session's work is done and it should stop cleanly.",
            inputSchema: {
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session to complete"),
                reason: z.string().optional().describe("Optional completion reason"),
            },
        },
        withToolErrors(async ({ session_id, reason }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            await ctx.mgmt.completeSession(session_id, reason);
            return jsonResult({ completed: true });
        }),
    );

    server.registerTool(
        "cancel_pending_messages",
        {
            title: "Cancel Pending Messages",
            description:
                "Cancel queued (not yet processed) messages in a session, identified by the client_message_ids they "
                + "were sent with. Pair with send_message's client_message_ids parameter.",
            inputSchema: {
                session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session holding the queued messages"),
                client_message_ids: z.array(z.string().min(1)).min(1).describe("Client message ids to cancel"),
            },
        },
        withToolErrors(async ({ session_id, client_message_ids }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            try {
                await ctx.mgmt.cancelPendingMessage(session_id, client_message_ids);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/not started|NotFound/i.test(msg)) {
                    // Pending-message cancellation rides the orchestration
                    // command channel, which only exists once the session's
                    // orchestration has started. Explain, don't confuse.
                    return errorResult(
                        "cannot cancel yet: this session's orchestration has not started, so the command channel "
                        + "is not live. Monitor the session (get_session_detail include: ['status']) and retry "
                        + "once orchestration_status is no longer NotFound.",
                        { session_id, client_message_ids },
                    );
                }
                throw err;
            }
            return jsonResult({ cancelled: true, client_message_ids });
        }),
    );

    // sendSessionEvent is a Web API session operation; in direct mode there is
    // no equivalent seam (events are worker-internal), so web-only.
    if (ctx.api) {
        server.registerTool(
            "send_session_event",
            {
                title: "Send Session Event",
                description:
                    "Inject a custom named event into a PilotSwarm session (e.g. a webhook-style signal an agent "
                    + "is waiting on). Not a chat message — use send_message for prompts.",
                inputSchema: {
                    session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The target session"),
                    event_name: z.string().min(1).describe("Event name the session listens for"),
                    data: z.record(z.string(), z.any()).optional().describe("Event payload"),
                },
            },
            withToolErrors(async ({ session_id, event_name, data }) => {
                if (!(await requireSession(session_id))) {
                    return errorResult("session not found", { session_id });
                }
                await ctx.api!.call("sendSessionEvent", { sessionId: session_id, eventName: event_name, data });
                return jsonResult({ sent: true, event_name });
            }),
        );
    }
}
