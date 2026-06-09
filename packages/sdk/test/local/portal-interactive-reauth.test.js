/**
 * Final-review fix (Finding 2) — FR-011 / SC-006 regression.
 *
 * The portal's auto re-auth path on the live websocket subscription
 * keys off `sessionEvent.eventType` (the canonical SDK shape used by
 * `packages/sdk/src/client.ts` and `packages/sdk/src/session-proxy.ts`).
 *
 * A previous revision of `maybeTriggerInteractiveReauth()` read
 * `sessionEvent.type` only, which silently missed every
 * `interaction_required` event delivered over the live websocket and
 * left the portal stuck waiting on an external trigger to refresh the
 * downstream token.
 *
 * This test pins the canonical event shape and asserts the auto
 * re-auth fires for both `tool.execution_complete` (real tool path)
 * and `system.tool_outcome` (synthetic envelope-decrypt path).
 */

import { describe, it, expect } from "vitest";
import { BrowserPortalTransport } from "../../../portal/src/browser-transport.js";

function makeTransport() {
    const calls = [];
    const transport = new BrowserPortalTransport({
        getAccessToken: async () => "admission-jwt",
        getDownstreamToken: async (opts) => {
            calls.push(opts ?? {});
            return "downstream-jwt";
        },
        onUnauthorized: () => {},
        onForbidden: () => {},
    });
    return { transport, calls };
}

async function waitForReauth(transport) {
    // The trigger schedules an async promise chain. Drain microtasks
    // until interactiveReauthInFlight clears (capped iterations).
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
        if (!transport.interactiveReauthInFlight) return;
    }
}

describe("Portal auto re-auth event shape (FR-011 / SC-006)", () => {
    it("fires for canonical { eventType: 'tool.execution_complete', data.outcome: 'interaction_required' }", async () => {
        const { transport, calls } = makeTransport();
        transport.maybeTriggerInteractiveReauth("session-1", {
            eventType: "tool.execution_complete",
            data: { outcome: "interaction_required" },
        });
        await waitForReauth(transport);
        expect(calls).toHaveLength(1);
        expect(calls[0].interactive).toBe(true);
    });

    it("fires for canonical { eventType: 'system.tool_outcome' } (envelope-decrypt synthetic path)", async () => {
        const { transport, calls } = makeTransport();
        transport.maybeTriggerInteractiveReauth("session-2", {
            eventType: "system.tool_outcome",
            data: { outcome: "interaction_required" },
        });
        await waitForReauth(transport);
        expect(calls).toHaveLength(1);
    });

    it("still supports the legacy { type } field for poll-path compatibility", async () => {
        const { transport, calls } = makeTransport();
        transport.maybeTriggerInteractiveReauth("session-3", {
            type: "tool.execution_complete",
            data: { outcome: "interaction_required" },
        });
        await waitForReauth(transport);
        expect(calls).toHaveLength(1);
    });

    it("does NOT fire for outcomes other than 'interaction_required'", async () => {
        const { transport, calls } = makeTransport();
        transport.maybeTriggerInteractiveReauth("session-4", {
            eventType: "tool.execution_complete",
            data: { outcome: "service_unavailable" },
        });
        await waitForReauth(transport);
        expect(calls).toHaveLength(0);
    });

    it("does NOT fire for unrelated eventTypes", async () => {
        const { transport, calls } = makeTransport();
        transport.maybeTriggerInteractiveReauth("session-5", {
            eventType: "assistant.message",
            data: {},
        });
        await waitForReauth(transport);
        expect(calls).toHaveLength(0);
    });

    it("debounces repeated triggers for the same session within the 30s window", async () => {
        const { transport, calls } = makeTransport();
        const evt = {
            eventType: "tool.execution_complete",
            data: { outcome: "interaction_required" },
        };
        transport.maybeTriggerInteractiveReauth("session-6", evt);
        await waitForReauth(transport);
        transport.maybeTriggerInteractiveReauth("session-6", evt);
        await waitForReauth(transport);
        expect(calls).toHaveLength(1);
    });
});
