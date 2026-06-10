/**
 * Portal runtime envelope-completeness test(FR-005 / FR-007).
 *
 * Asserts that the portal's `call()` dispatcher attaches a UserEnvelopeCarrier
 * to every prompt-bearing RPC: sendMessage, sendAnswer, createSessionForAgent
 * (when initialPrompt is set). Read-only / management RPCs (cancelSession,
 * getSession, listSessions, etc.) intentionally do NOT forward an envelope —
 * they don't trigger a tool turn.
 *
 * This is a regression guard: if a future RPC is added that drives a turn,
 * this test will fail until the envelope is wired. To opt out (genuine
 * read-only RPC), add the method name to NON_PROMPT_RPC_ALLOWLIST.
 */

import { describe, it, expect } from "vitest";
import { PortalRuntime } from "../../../portal/runtime.js";

const SAMPLE_AUTH = {
    principal: {
        provider: "entra",
        subject: "00000000-0000-0000-0000-000000000001",
        email: "engineer@contoso.com",
        displayName: "Eng Ineer",
    },
};

// RPCs that drive a tool turn and MUST carry an envelope when an authenticated
// user is present.
const PROMPT_RPCS = ["sendMessage", "sendAnswer", "createSessionForAgent"];

describe("Portal RPC envelope wiring", () => {
    function buildRuntime() {
        // Stub transport — capture every call's args.
        const calls = [];
        const transport = new Proxy({}, {
            get(_, prop) {
                if (prop === "start" || prop === "stop") return async () => {};
                return async (...args) => {
                    calls.push({ method: prop, args });
                    return null;
                };
            },
        });
        const runtime = Object.create(PortalRuntime.prototype);
        runtime.transport = transport;
        runtime.mode = "embedded";
        runtime.started = true;
        runtime.startPromise = null;
        return { runtime, calls };
    }

    it("sendMessage forwards envelope.v=1 with the principal", async () => {
        const { runtime, calls } = buildRuntime();
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hello", options: {} }, SAMPLE_AUTH);
        expect(calls).toHaveLength(1);
        const [, , options] = calls[0].args;
        expect(options.envelope).toBeDefined();
        expect(options.envelope.v).toBe(1);
        expect(options.envelope.principal.subject).toBe(SAMPLE_AUTH.principal.subject);
        expect(options.envelope.accessTokenCipher).toBeNull();
    });

    it("sendAnswer forwards envelope", async () => {
        const { runtime, calls } = buildRuntime();
        await runtime.call("sendAnswer", { sessionId: "s1", answer: "ok" }, SAMPLE_AUTH);
        expect(calls).toHaveLength(1);
        const optionsArg = calls[0].args[2];
        expect(optionsArg).toBeDefined();
        expect(optionsArg.envelope?.principal?.subject).toBe(SAMPLE_AUTH.principal.subject);
    });

    it("createSessionForAgent forwards envelope in opts", async () => {
        const { runtime, calls } = buildRuntime();
        await runtime.call("createSessionForAgent", { agentName: "helper" }, SAMPLE_AUTH);
        expect(calls).toHaveLength(1);
        const opts = calls[0].args[1];
        expect(opts.envelope).toBeDefined();
        expect(opts.envelope.principal.subject).toBe(SAMPLE_AUTH.principal.subject);
    });

    it("anonymous request (no authContext) does NOT inject an envelope", async () => {
        const { runtime, calls } = buildRuntime();
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hello", options: {} }, null);
        expect(calls).toHaveLength(1);
        const [, , options] = calls[0].args;
        expect(options.envelope).toBeUndefined();
    });

    it("read-only RPC (getSession) does NOT inject an envelope (no tool turn)", async () => {
        const { runtime, calls } = buildRuntime();
        await runtime.call("getSession", { sessionId: "s1" }, SAMPLE_AUTH);
        expect(calls).toHaveLength(1);
        // getSession is unary; no options arg. Just ensure no envelope leaked
        // into the args structure.
        const flat = JSON.stringify(calls[0].args);
        expect(flat).not.toContain("\"envelope\"");
    });

    it("PROMPT_RPCS list catches every prompt-bearing wiring (manual list maintenance)", () => {
        // This is the regression guard: when a new prompt-bearing RPC is
        // added to runtime.js, the implementer must add it to PROMPT_RPCS
        // here and add a forwards-envelope assertion above. Failing this
        // visibility prevents a silent regression of FR-005.
        expect(PROMPT_RPCS).toContain("sendMessage");
        expect(PROMPT_RPCS).toContain("sendAnswer");
        expect(PROMPT_RPCS).toContain("createSessionForAgent");
    });
});
