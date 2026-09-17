import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Turn- and queue-level session control (proposal G3) — finer levers than
 * abort_session's whole-session cancel:
 *
 *   stop_turn               abort the in-flight turn, keep the session
 *   complete_session        mark done (distinct from cancelled)
 *   cancel_pending_messages drop queued messages by client message id
 *   raise_signal            queue a typed durable signal
 *   send_session_event      compatibility wrapper for raise_signal
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
                "Abort the in-flight turn or cancel the current parked signal wait without cancelling the session — it stays "
                + "alive and accepts new messages. Use abort_session only when the whole session should end.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session whose current turn to stop"),
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
                session_id: sessionIdShape().describe("The session to complete"),
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
                session_id: sessionIdShape().describe("The session holding the queued messages"),
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

    server.registerTool(
        "raise_signal",
        {
            title: "Raise Signal",
            description:
                "Queue a typed durable signal for a session. Matching signals resume wait_for_signal; other signals "
                + "buffer unless wake=true requests an attributed turn. A new session starts without a chat prompt. "
                + "The queued receipt does not mean the signal was consumed. Use send_message for instructions.",
            inputSchema: {
                session_id: sessionIdShape().describe("The target session"),
                name: z.string().regex(/^[a-z0-9_-]{1,64}$/).describe("Case-sensitive signal name"),
                data: z.json().optional().describe("JSON data, at most 32 KiB UTF-8; never runtime commands"),
                payload_ref: z.string().min(1).max(1024).optional().describe("Opaque reference, at most 1024 JSON-encoded UTF-8 bytes including quotes/escapes; never fetched automatically"),
                signal_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("Caller-stable dedupe id; omitted for a server-generated id"),
                wake: z.boolean().optional().describe("Request an attributed turn even without a matching wait (default false)"),
            },
        },
        withToolErrors(async ({ session_id, name, data, payload_ref, signal_id, wake }) => {
            const result = await ctx.mgmt.raiseSignal(session_id, name, {
                ...(data !== undefined ? { data } : {}),
                ...(payload_ref !== undefined ? { payloadRef: payload_ref } : {}),
                ...(signal_id !== undefined ? { signalId: signal_id } : {}),
                ...(wake !== undefined ? { wake } : {}),
            });
            return jsonResult(result);
        }),
    );

    server.registerTool(
        "send_session_event",
        {
            title: "Send Session Event",
            description:
                "Deprecated compatibility wrapper for raise_signal with name=event_name and wake=false. "
                + "The entire payload is untrusted signal data, never a raw prompt, answer, or command.",
            inputSchema: {
                session_id: sessionIdShape().describe("The target session"),
                event_name: z.string().regex(/^[a-z0-9_-]{1,64}$/).describe("Signal name"),
                data: z.json().optional().describe("JSON signal data, at most 32 KiB UTF-8"),
            },
        },
        withToolErrors(async ({ session_id, event_name, data }) => {
            await ctx.mgmt.sendSessionEvent(session_id, event_name, data);
            return jsonResult({ sent: true, event_name });
        }),
    );
}
