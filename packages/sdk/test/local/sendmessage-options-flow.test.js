/**
 * CLI sendMessage normal-path regression test (rubber-duck #4 from
 * Phase 1 plan review).
 *
 * Pre-fix: NodeSdkTransport.sendMessage's normal path called
 * `sessionHandle.send(prompt)` and dropped the `sendOptions` builder
 * (clientMessageIds, envelope, etc.). Only the enqueueOnly branch
 * forwarded options. This test asserts that both branches forward the
 * same options object so future refactors don't reintroduce the bug.
 *
 * Lives in packages/sdk/test/local because the run-tests harness only
 * walks SDK test directories. Imports the production CLI module.
 */

import { describe, it, expect } from "vitest";
import { NodeSdkTransport } from "pilotswarm-cli/portal";

function buildHarness() {
    const calls = [];
    const fakeSessionHandle = {
        send: async (prompt, sendOptions) => {
            calls.push({ branch: "sessionHandle.send", prompt, sendOptions });
        },
    };

    const fakeMgmt = {
        getSession: async () => ({
            status: "running",
            orchestrationStatus: "Running",
            isSystem: false,
            parentSessionId: null,
        }),
    };

    const transport = {
        mode: "embedded",
        mgmt: fakeMgmt,
        sessionHandles: new Map(),
        getSessionHandle: async () => fakeSessionHandle,
        sendMessage: NodeSdkTransport.prototype.sendMessage,
    };

    return { transport, calls };
}

describe("CLI NodeSdkTransport.sendMessage forwards sendOptions on every branch", () => {
    it("normal path forwards clientMessageIds", async () => {
        const { transport, calls } = buildHarness();
        await transport.sendMessage("s1", "hello", { clientMessageIds: ["msg-1"] });
        expect(calls).toHaveLength(1);
        expect(calls[0].sendOptions).toEqual({ clientMessageIds: ["msg-1"] });
    });

    it("normal path forwards envelope", async () => {
        const { transport, calls } = buildHarness();
        const envelope = {
            v: 1,
            principal: { provider: "entra", subject: "u1", email: null, displayName: null },
            accessTokenCipher: null,
        };
        await transport.sendMessage("s1", "hello", { envelope });
        expect(calls).toHaveLength(1);
        expect(calls[0].sendOptions).toEqual({ envelope });
    });

    it("enqueueOnly path forwards envelope + clientMessageIds together", async () => {
        const { transport, calls } = buildHarness();
        const envelope = {
            v: 1,
            principal: { provider: "entra", subject: "u2", email: null, displayName: null },
            accessTokenCipher: null,
        };
        await transport.sendMessage("s1", "hello", {
            enqueueOnly: true,
            envelope,
            clientMessageIds: ["msg-2"],
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].sendOptions).toEqual({
            clientMessageIds: ["msg-2"],
            envelope,
        });
    });

    it("with no options sendOptions stays undefined (backwards compat)", async () => {
        const { transport, calls } = buildHarness();
        await transport.sendMessage("s1", "hello");
        expect(calls).toHaveLength(1);
        expect(calls[0].sendOptions).toBeUndefined();
    });
});
